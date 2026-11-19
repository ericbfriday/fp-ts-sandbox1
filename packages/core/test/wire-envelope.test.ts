/**
 * Contract test for `@friday-friday/core/wire` (RFC-0001 §5–§6, IDEA §4.2–§4.3, #33).
 * Every assertion goes through the public interface; expected values are literals (goldens).
 */
import { type TaggedError, taggedError } from "@friday-friday/core"
import { fromWire, PROBLEM_CONTENT_TYPE, sanitize, toDefect, toProblem } from "@friday-friday/core/wire"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
// Imported the way adapters (#37–#40) do: a workspace-only subpath (source condition only, never published).
import { goldenProblems } from "@friday-friday/core/test/wire-golden"

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
      expect(sanitize(e)).toStrictEqual({ _tag: "InternalDefect", message: "Internal server error" })
      expect(toProblem(e)).toStrictEqual(toProblem(toDefect(e)))
    }
  })

  it("with a safeProps allowlist, only _tag, message and the named props pass", () => {
    const e = { _tag: "ApiError", code: "E_AUTH", headers: { authorization: "Bearer abc" }, message: "denied" }
    expect(sanitize(e)).toStrictEqual({
      _tag: "ApiError",
      code: "E_AUTH",
      headers: { authorization: "Bearer abc" },
      message: "denied"
    })
    expect(sanitize(e, { safeProps: ["code"] })).toStrictEqual({ _tag: "ApiError", code: "E_AUTH", message: "denied" })
    expect(sanitize(e, { safeProps: [] })).toStrictEqual({ _tag: "ApiError", message: "denied" })
  })

  it.each([
    ["an object", { secret: 1 }],
    ["a number", 42],
    ["null", null],
    ["an array", ["x"]]
  ])("drops a non-string message (%s): message is a string or absent", (_, message) => {
    // as it arrives from untyped code: `object` hides the ill-typed message from the checker
    const props: object = { id: "1", message }
    const e: TaggedError<string> = Object.assign({ _tag: "X" }, props)
    expect(sanitize(e)).toStrictEqual({ _tag: "X", id: "1" })
    expect(toProblem(e, 400)).toStrictEqual({
      type: "https://friday-friday.dev/errors/x",
      title: "X",
      status: 400,
      tag: "X",
      id: "1"
    })
  })

  it("drops values nested deeper than the depth cap instead of overflowing", () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 10_000; i++) deep = { d: deep }
    expect(() => JSON.stringify(sanitize(Weird({ deep })))).not.toThrow()
  })
})

describe("toProblem — RFC 9457 body (RFC-0001 §6)", () => {
  it.each(goldenProblems)("$name", ({ error, status, options, body }) => {
    const p = toProblem(error, status, options)
    expect(p).toStrictEqual(body)
    roundTrips(p)
  })
})

describe("toProblem — a tag with no status is a defect (RFC-0001 §6 \"everything else → 500 as InternalDefect\")", () => {
  const defectBody = {
    type: "https://friday-friday.dev/errors/internal-defect",
    title: "Internal Defect",
    status: 500,
    detail: "Internal server error",
    tag: "InternalDefect"
  }
  // A tag in no table (not a fixed tag: `DbUnavailable` has a default 503 since ADR-0005).
  const leaky = { _tag: "ReplicaLagging", host: "db.internal:5432", message: "conn refused" }

  it.each([
    ["an empty map", {}],
    ["a map without the tag", { Conflict: 409 }],
    ["no status at all", undefined],
    ["a non-error explicit status", 200]
  ])("sends the fixed envelope, never the tag, message or props, for %s", (_, status) => {
    const p = toProblem(leaky, status)
    expect(p).toStrictEqual(defectBody)
    expect(JSON.stringify(p)).not.toMatch(/db\.internal|conn refused|ReplicaLagging/)
  })

  it("hands the original error to the reporter", () => {
    const seen: Array<unknown> = []
    toProblem(leaky, {}, { report: (c) => seen.push(c) })
    expect(seen).toStrictEqual([leaky])
    expect(seen[0]).toBe(leaky)
  })

  it("does not call the reporter for a tag that resolves", () => {
    const seen: Array<unknown> = []
    toProblem(NotFound({ resource: "user", id: "1" }), {}, { report: (c) => seen.push(c) })
    expect(seen).toStrictEqual([])
  })

  it("never throws when the reporter does", () => {
    expect(toProblem(leaky, {}, {
      report: () => {
        throw new Error("reporter down")
      }
    })).toStrictEqual(defectBody)
  })
})

describe("toProblem — strict: only the caller's statuses count (#37)", () => {
  const nf = NotFound({ resource: "user", id: "1", message: "gone" })
  const defectBody = {
    type: "https://friday-friday.dev/errors/internal-defect",
    title: "Internal Defect",
    status: 500,
    detail: "Internal server error",
    tag: "InternalDefect"
  }

  it("by default the RFC §6 table fills gaps in the caller's map", () => {
    expect(toProblem(nf, { Conflict: 409 }).status).toBe(404)
    expect(toProblem(nf, { Conflict: 409 }).tag).toBe("NotFound")
  })

  it("strict: a tag missing from the map is masked and reported, even one the RFC table lists", () => {
    const seen: Array<unknown> = []
    expect(toProblem(nf, { Conflict: 409 }, { strict: true, report: (c) => seen.push(c) })).toStrictEqual(defectBody)
    expect(seen).toStrictEqual([nf])
  })

  it("strict: a map hit or an explicit error status keeps the tag", () => {
    expect(toProblem(nf, { NotFound: 410 }, { strict: true })).toMatchObject({ status: 410, tag: "NotFound" })
    expect(toProblem(nf, 404, { strict: true })).toMatchObject({ status: 404, tag: "NotFound" })
  })

  it("strict: a non-error status in the map is not a status, so the tag is masked", () => {
    expect(toProblem(nf, { NotFound: 200 }, { strict: true })).toStrictEqual(defectBody)
  })

  it("strict: the defect envelope itself is always a 500, never re-reported", () => {
    const seen: Array<unknown> = []
    expect(toProblem(toDefect("boom"), {}, { strict: true, report: (c) => seen.push(c) })).toStrictEqual(defectBody)
    expect(seen).toStrictEqual([])
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

  it("accepts a sanitized error (tRPC data.friday_friday) as well as a problem body", () => {
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

  it("never yields a non-string message, whatever the wire carries", () => {
    expect(fromWire({ _tag: "X", message: 42 })).toStrictEqual({ _tag: "X" })
    expect(fromWire({ tag: "X", status: 400, detail: { a: 1 } })).toStrictEqual({ _tag: "X" })
    expect(fromWire({ tag: "X", status: 400, shadowed: { message: { a: 1 } } })).toStrictEqual({ _tag: "X" })
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

  it("carries an optional correlation digest (RFC-0001 §2), and only a string one", () => {
    const d = toDefect(new Error(secret), undefined, "req-7f3a")
    expect(d).toStrictEqual({ _tag: "InternalDefect", message: "Internal server error", digest: "req-7f3a" })
    roundTrips(d)
    expect(toProblem(d)).toStrictEqual({
      type: "https://friday-friday.dev/errors/internal-defect",
      title: "Internal Defect",
      status: 500,
      detail: "Internal server error",
      tag: "InternalDefect",
      digest: "req-7f3a"
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed input
    expect(toDefect("x", undefined, 42 as unknown as string)).toStrictEqual(toDefect("x"))
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

  const defectAt = (status: number) => ({
    type: "https://friday-friday.dev/errors/internal-defect",
    title: "Internal Defect",
    status,
    detail: "Internal server error",
    tag: "InternalDefect"
  })

  it("sanitize / toProblem never throw, always round-trip; the body keeps the tag or is the defect envelope", () => {
    fc.assert(fc.property(arbError, arbStatus, (e, status) => {
      roundTrips(sanitize(e))
      const p = toProblem(e, status)
      roundTrips(p)
      if (p.tag !== e._tag) expect(p).toStrictEqual(defectAt(500))
      expect(p.status >= 400 && p.status <= 599).toBe(true)
    }))
  })

  it("an explicit error status always keeps the tag, and error props survive the round-trip", () => {
    fc.assert(fc.property(arbError, fc.integer({ min: 400, max: 599 }), (e, status) => {
      const p = toProblem(e, status)
      expect(p.status).toBe(status)
      expect(p.tag).toBe(e._tag)
      expect(fromWire(JSON.parse(JSON.stringify(p)))).toStrictEqual(sanitize(e))
    }))
  })

  it("problem → error → problem is a fixed point", () => {
    fc.assert(fc.property(arbError, arbStatus, (e, status) => {
      const p = toProblem(e, status)
      const back = fromWire(JSON.parse(JSON.stringify(p)))
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
