/**
 * Contract test for `@friday-friday/core/wire` (RFC-0001 §5–§6, IDEA §4.2–§4.3, #33).
 * Every assertion goes through the public interface; expected values are literals (goldens).
 */
import { type TaggedError, taggedError } from "@friday-friday/core"
import { fromWire, PROBLEM_CONTENT_TYPE, sanitize, toDefect, toProblem } from "@friday-friday/core/wire"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { goldenProblems } from "./wire-golden.js"

const Conflict = taggedError("Conflict")<{ field: string }>()
const NotFound = taggedError("NotFound")<{ resource: string; id: string }>()
const Weird = taggedError("Weird")<Record<string, unknown>>()

/** RFC-0001 §5.2: every output of the module survives JSON and structuredClone unchanged. */
const roundTrips = (x: unknown): void => {
  expect(JSON.parse(JSON.stringify(x))).toStrictEqual(x)
  expect(structuredClone(x)).toStrictEqual(x)
}

describe("sanitize — JSON-safe projection (RFC-0001 §5.3)", () => {
  it("keeps _tag, message and plain props; drops cause", () => {
    const e = Conflict({ field: "email", message: "taken", cause: new Error("pg: duplicate key") })
    expect(sanitize(e)).toStrictEqual({ _tag: "Conflict", field: "email", message: "taken" })
  })

  it("drops non-JSON-safe values recursively, never throws, and round-trips", () => {
    const e = Weird({
      big: 10n,
      fn: () => 1,
      sym: Symbol("s"),
      undef: undefined,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      negZero: -0,
      when: new Date("2026-11-17T12:00:00.000Z"),
      badDate: new Date("nope"),
      map: new Map([["a", 1]]),
      err: new Error("secret"),
      list: [1, 2n, () => 3, "x", undefined],
      nested: { keep: "yes", big: 1n, cause: "server-only", deeper: { fn: () => 0, ok: true } },
      nullProto: Object.setPrototypeOf({ a: 1 }, null) satisfies unknown
    })
    const out = sanitize(e)
    expect(out).toStrictEqual({
      _tag: "Weird",
      negZero: 0,
      when: "2026-11-17T12:00:00.000Z",
      list: [1, null, null, "x", null],
      nested: { keep: "yes", deeper: { ok: true } },
      nullProto: { a: 1 }
    })
    roundTrips(out)
  })

  it("survives cycles, throwing getters and __proto__ keys", () => {
    const cyclic: Record<string, unknown> = { name: "loop" }
    cyclic["self"] = cyclic
    const getter = Object.defineProperty({ fine: 1 }, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("getter")
      }
    })
    const hostile: unknown = JSON.parse("{\"__proto__\": {\"polluted\": true}, \"x\": 1}")
    const out = sanitize(Weird({ cyclic, getter, hostile }))
    expect(out).toStrictEqual({ _tag: "Weird", cyclic: { name: "loop" }, getter: { fine: 1 }, hostile })
    expect(Object.getPrototypeOf(out["hostile"])).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
    roundTrips(out)
  })

  it("never throws on a hostile top-level error (throwing proxy / unreadable _tag)", () => {
    const trap = new Proxy({ _tag: "NotFound" }, {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    const unreadable = Object.defineProperty({ id: "1", _tag: "NotFound" }, "_tag", {
      enumerable: true,
      get: () => {
        throw new Error("no tag for you")
      }
    })
    for (const e of [trap, unreadable]) {
      expect(sanitize(e)).toStrictEqual({ _tag: "InternalDefect" })
      expect(toProblem(e).status).toBe(500)
    }
  })

  it("drops values nested deeper than the depth cap instead of overflowing", () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 10_000; i++) deep = { d: deep }
    expect(() => JSON.stringify(sanitize(Weird({ deep })))).not.toThrow()
  })
})

describe("toProblem — RFC 9457 body (RFC-0001 §6)", () => {
  it.each(goldenProblems)("$name", ({ error, status, body }) => {
    const p = status === undefined ? toProblem(error) : toProblem(error, status)
    expect(p).toStrictEqual(body)
    roundTrips(p)
  })
})

describe("fromWire — parse-back (RFC-0001 §6 `tag` reconstruction key)", () => {
  const golden = (name: string) => goldenProblems.find((g) => g.name.startsWith(name))!.body

  it("rebuilds the tagged error from a problem body; detail → message", () => {
    expect(fromWire(golden("default status"))).toStrictEqual({
      _tag: "NotFound",
      message: "no such user",
      resource: "user",
      id: "42"
    })
  })

  it("restores props that collided with reserved members", () => {
    expect(fromWire(golden("reserved-member"))).toStrictEqual({
      _tag: "AuthApiError",
      message: "session expired",
      code: "SESSION_EXPIRED",
      status: 401,
      type: "session",
      title: "Session",
      detail: "raw detail",
      instance: "/login",
      tag: "auth",
      shadowed: true
    })
  })

  it.each(goldenProblems)("problem → error → problem is a fixed point: $name", ({ body }) => {
    const wire: unknown = JSON.parse(JSON.stringify(body))
    const e = fromWire(wire)
    expect(e).toBeDefined()
    roundTrips(e)
    expect(toProblem(e!, body.status)).toStrictEqual(body)
  })

  it("error → problem → error is lossless for _tag, message and safe props", () => {
    const e = NotFound({ resource: "order", id: "7", message: "order 7 is gone", cause: new Error("db") })
    expect(fromWire(JSON.parse(JSON.stringify(toProblem(e))))).toStrictEqual({
      _tag: "NotFound",
      resource: "order",
      id: "7",
      message: "order 7 is gone"
    })
  })

  it("accepts a sanitized error (tRPC data.fl) as well as a problem body", () => {
    const fl: unknown = JSON.parse(JSON.stringify(sanitize(Conflict({ field: "email", message: "taken" }))))
    expect(fromWire(fl)).toStrictEqual({ _tag: "Conflict", field: "email", message: "taken" })
  })

  it("falls back to the inverse status table when a problem has no tag", () => {
    expect(fromWire({ type: "about:blank", title: "Not Found", status: 404, detail: "gone" })).toStrictEqual({
      _tag: "NotFound",
      message: "gone"
    })
    expect(fromWire({ title: "Unauthorized", status: 401 })).toStrictEqual({ _tag: "Unauthenticated" })
    expect(fromWire({ title: "Forbidden", status: 403 })).toStrictEqual({ _tag: "Forbidden" })
    expect(fromWire({ title: "Conflict", status: 409 })).toStrictEqual({ _tag: "Conflict" })
    expect(fromWire({ title: "Unprocessable", status: 422 })).toStrictEqual({ _tag: "ValidationFailure" })
    expect(fromWire({ title: "Internal Server Error", status: 500, detail: "x" })).toStrictEqual({
      _tag: "InternalDefect",
      message: "x"
    })
  })

  it("returns undefined for anything it cannot attribute to a tag", () => {
    for (const u of [undefined, null, 42, "NotFound", [], {}, { status: 400, title: "Bad Request" }, { tag: 1 }]) {
      expect(fromWire(u)).toBeUndefined()
    }
  })

  it("treats input as untrusted: shadowed cannot replace the tag; output is re-projected", () => {
    const body: unknown = JSON.parse(
      "{\"tag\": \"NotFound\", \"status\": 404, \"shadowed\": {\"_tag\": \"Admin\", \"id\": \"1\"}, \"__proto__\": {\"x\": 1}}"
    )
    const e = fromWire(body)
    expect(e?._tag).toBe("NotFound")
    expect(e?.["id"]).toBe("1")
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype)
    expect(fromWire({ _tag: "Conflict", fn: () => 1, big: 1n })).toStrictEqual({ _tag: "Conflict" })
  })
})

describe("toDefect — the one defect envelope (IDEA §4.3, RFC-0001 §2)", () => {
  const secret = "connect ECONNREFUSED postgres://admin:hunter2@db:5432"

  it.each([
    ["an Error", new Error(secret)],
    ["a string", secret],
    ["a plain object", { reason: secret }],
    ["a tagged error", { _tag: "Conflict", message: secret }],
    ["undefined", undefined]
  ])("gives a fixed client message for %s and never puts the cause on the wire", (_, cause) => {
    const d = toDefect(cause)
    expect(d).toStrictEqual({ _tag: "InternalDefect", message: "Internal server error" })
    expect(JSON.stringify(toProblem(d))).not.toContain("hunter2")
    roundTrips(d)
  })

  it("hands the original cause to the reporter", () => {
    const cause = new Error(secret)
    const seen: Array<unknown> = []
    toDefect(cause, (c) => seen.push(c))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(cause)
  })

  it("never throws, even when the reporter does", () => {
    expect(toDefect("x", () => {
      throw new Error("reporter down")
    })).toStrictEqual({ _tag: "InternalDefect", message: "Internal server error" })
  })

  it("its problem form is the golden defect body (default status 500)", () => {
    const golden = goldenProblems.find((g) => g.error._tag === "InternalDefect")!
    expect(toProblem(toDefect(new Error(secret)))).toStrictEqual(golden.body)
  })
})

describe("PROBLEM_CONTENT_TYPE", () => {
  it("is the RFC 9457 media type", () => {
    expect(PROBLEM_CONTENT_TYPE).toBe("application/problem+json")
  })
})

describe("contract over arbitrary props (fast-check)", () => {
  const key = fc.oneof(
    fc.constantFrom(
      "type",
      "title",
      "status",
      "detail",
      "instance",
      "tag",
      "shadowed",
      "message",
      "cause",
      "__proto__"
    ),
    fc.string()
  )
  const anything = fc.anything({
    key,
    withBigInt: true,
    withBoxedValues: true,
    withDate: true,
    withMap: true,
    withSet: true,
    withNullPrototype: true,
    withObjectString: true,
    withSparseArray: true,
    withTypedArray: true
  })
  // fast-check dictionaries are null-prototype by default, like a hostile or Object.create(null) error
  const arbError = fc.tuple(fc.string(), fc.dictionary(key, anything, { maxKeys: 6 })).map((
    [tag, props]
  ): TaggedError<string> => Object.assign(props, { _tag: tag }))
  const arbStatus = fc.option(fc.oneof(fc.integer({ min: 0, max: 999 }), fc.dictionary(fc.string(), fc.integer())), {
    nil: undefined
  })

  it("sanitize / toProblem never throw, always round-trip, and status is an error status", () => {
    fc.assert(fc.property(arbError, arbStatus, (e, status) => {
      roundTrips(sanitize(e))
      const p = status === undefined ? toProblem(e) : toProblem(e, status)
      roundTrips(p)
      expect(p.tag).toBe(e._tag)
      expect(p.status >= 400 && p.status <= 599).toBe(true)
    }))
  })

  it("problem → error → problem is a fixed point and error props survive", () => {
    fc.assert(fc.property(arbError, arbStatus, (e, status) => {
      const p = status === undefined ? toProblem(e) : toProblem(e, status)
      const back = fromWire(JSON.parse(JSON.stringify(p)))
      expect(back).toStrictEqual(sanitize(e))
      expect(toProblem(back!, p.status)).toStrictEqual(p)
    }))
  })

  it("fromWire never throws on arbitrary JSON", () => {
    fc.assert(fc.property(fc.jsonValue(), (j) => {
      const e = fromWire(j)
      if (e !== undefined) roundTrips(e)
    }))
  })
})
