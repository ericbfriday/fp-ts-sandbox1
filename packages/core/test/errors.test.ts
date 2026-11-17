import {
  andThen,
  err,
  fromNullable,
  map,
  mapErr,
  matchTag,
  ok,
  orElse,
  Panic,
  type Result,
  taggedError,
  tap,
  tapErr,
  toThrowable,
  trySync
} from "@friday-friday/core"
import { describe, expect, it } from "vitest"
import { type Forbidden, NotFound, type NotFound as NotFoundT, Timeout } from "./_fixtures.js"

/** Runs `run`, returns the thrown Panic; fails the test loudly if anything else happened. */
const capturePanic = (run: () => unknown): Panic => {
  try {
    run()
  } catch (x) {
    if (x instanceof Panic) return x
    throw new Error(`expected a Panic, got: ${String(x)}`, { cause: x })
  }
  throw new Error("expected a Panic, but nothing was thrown")
}

describe("taggedError", () => {
  it("builds plain data: { _tag, ...props } with Object.prototype only", () => {
    const e = NotFound({ resource: "user", id: "1" })
    expect(e).toStrictEqual({ _tag: "NotFound", resource: "user", id: "1" })
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype)
    expect(NotFound.tag).toBe("NotFound")
    expect(Timeout({})).toStrictEqual({ _tag: "Timeout" })
  })

  it("carries message and (server-side) cause when given", () => {
    const cause = new Error("db down")
    const e = NotFound({ resource: "user", id: "1", message: "no such user", cause })
    expect(e.message).toBe("no such user")
    expect("cause" in e && e.cause).toBe(cause)
    expect("cause" in NotFound({ resource: "u", id: "2" })).toBe(false)
  })

  it("is() is structural: separate factory instances, wire copies and null-prototype objects all match", () => {
    const Other: typeof NotFound = taggedError("NotFound")<{ resource: string; id: string }>()
    const e = Other({ resource: "user", id: "1" })
    expect(NotFound.is(e)).toBe(true)
    expect(Other.is(NotFound({ resource: "user", id: "1" }))).toBe(true)
    expect(NotFound.is(JSON.parse(JSON.stringify(e)))).toBe(true)
    expect(NotFound.is(structuredClone(e))).toBe(true)
    expect(NotFound.is({ _tag: "NotFound" })).toBe(true)
    expect(NotFound.is(Object.assign(Object.create(null), { _tag: "NotFound" }))).toBe(true)
  })

  it("is() never uses instanceof or the prototype chain", () => {
    const e = NotFound({ resource: "user", id: "1" })
    expect(() => NotFound.is(e)).not.toThrow()
    // An object that only has _tag through its prototype is NOT a plain tagged error on the wire,
    // but `in` sees inherited keys: document the structural rule precisely — own-or-inherited `_tag`.
    expect(NotFound.is(Object.create({ _tag: "NotFound" }))).toBe(true)
    expect(NotFound.is(Forbidden_({ reason: "x" }))).toBe(false)
    expect(NotFound.is({ _tag: "Forbidden" })).toBe(false)
    expect(NotFound.is({ _tag: "notfound" })).toBe(false)
    expect(NotFound.is("NotFound")).toBe(false)
    expect(NotFound.is(null)).toBe(false)
    expect(NotFound.is(undefined)).toBe(false)
    expect(NotFound.is({})).toBe(false)
    expect(NotFound.is([])).toBe(false)
  })
})

const Forbidden_ = taggedError("Forbidden")<{ reason: string }>()

describe("toThrowable", () => {
  it("produces a real Error named after _tag with the tagged error attached as data", () => {
    const e = NotFound({ resource: "user", id: "1", message: "no such user" })
    const t = toThrowable(e)
    expect(t).toBeInstanceOf(Error)
    expect(t.name).toBe("NotFound")
    expect(t.message).toBe("no such user")
    expect(t.data).toBe(e)
    expect(String(t)).toBe("NotFound: no such user")
    expect("cause" in t).toBe(false)
  })

  it("forwards the tagged error's cause and tolerates a missing message", () => {
    const cause = new Error("db down")
    const t = toThrowable(NotFound({ resource: "user", id: "1", cause }))
    expect(t.cause).toBe(cause)
    expect(t.message).toBe("")
    expect(t.name).toBe("NotFound")
  })
})

describe("Panic", () => {
  const boom = new Error("boom")
  const r: Result<number, string> = ok(1)
  const e: Result<number, string> = err("bad")
  const throwing = (): never => {
    throw boom
  }

  it("an Error cause keeps its message and String() form", () => {
    const p = new Panic(boom)
    expect(p.message).toBe("boom")
    expect(String(p)).toBe("Panic: boom")
  })

  it.each<[string, unknown, string]>([
    ["a string", "plain string", "plain string"],
    ["a plain object", { a: 1 }, "{\"a\":1}"],
    [
      "a tagged error with a message",
      NotFound({ resource: "user", id: "1", message: "no such user" }),
      "NotFound: no such user"
    ],
    ["a tagged error without a message", NotFound({ resource: "user", id: "1" }), "NotFound"],
    ["an array", [1, "two"], "[1,\"two\"]"],
    ["a number", 42, "42"],
    ["undefined", undefined, "undefined"],
    ["a bigint (not JSON-safe)", 10n, "10"]
  ])("built from %s, Panic has a readable message, never [object Object]", (_name, cause, message) => {
    const p = new Panic(cause)
    expect(p.message).toBe(message)
    expect(p.cause).toBe(cause)
  })

  it("built from a cyclic plain object, Panic still constructs (falls back to String())", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const p = new Panic(cyclic)
    expect(p.cause).toBe(cyclic)
    expect(typeof p.message).toBe("string")
  })

  it("does not re-wrap a Panic thrown by a nested combinator: cause stays the original", () => {
    const p = capturePanic(() => andThen(r, () => map(ok(2), throwing)))
    expect(p.cause).toBe(boom)
  })

  it("callbacks on the non-matching branch are never invoked, so they cannot panic", () => {
    expect(map(e, throwing)).toBe(e)
    expect(mapErr(r, throwing)).toBe(r)
    expect(andThen(e, throwing)).toBe(e)
    expect(orElse(r, throwing)).toBe(r)
    expect(tap(e, throwing)).toBe(e)
    expect(tapErr(r, throwing)).toBe(r)
    expect(fromNullable(1, throwing)).toStrictEqual(ok(1))
  })

  it("matchTag with a tag that has no handler at runtime (off-the-wire data) is a defect", () => {
    const wire: Result<number, NotFoundT | Forbidden> = JSON.parse("{\"ok\":false,\"error\":{\"_tag\":\"Unknown\"}}")
    expect(() => matchTag(wire, { ok: () => 0, NotFound: () => 1, Forbidden: () => 2 })).toThrow(Panic)
  })
})

describe("trySync (boundary triage, RFC-0001 §3)", () => {
  it("returns ok when fn succeeds", () => {
    expect(trySync(() => 42, { catch: () => "never" })).toEqual(ok(42))
  })

  it("maps a thrown cause to err via catch", () => {
    const r = trySync<number, string>(() => {
      throw "boom"
    }, { catch: (c) => `mapped:${String(c)}` })
    expect(r).toEqual(err("mapped:boom"))
  })

  it("treats an unmapped throw (catch returns undefined) as a defect: Panic with the original as cause", () => {
    const p = capturePanic(() =>
      trySync(() => {
        throw "boom"
      }, { catch: () => undefined })
    )
    expect(p.cause).toBe("boom")
    expect(p.message).toBe("boom")
  })

  it("calls rethrow first, so framework sentinels propagate untouched (not mapped, not Panicked)", () => {
    const sentinel = new Error("sentinel: framework control flow")
    let caught: unknown
    try {
      trySync(() => {
        throw sentinel
      }, {
        rethrow: (c) => {
          if (c instanceof Error) throw c
        },
        catch: () => "mapped"
      })
    } catch (x) {
      caught = x
    }
    expect(caught).toBe(sentinel)
  })

  it("a throwing catch handler is itself a defect: Panic with the handler's throw as cause", () => {
    const boom = new Error("handler boom")
    const p = capturePanic(() =>
      trySync(() => {
        throw "original"
      }, {
        catch: () => {
          throw boom
        }
      })
    )
    expect(p.cause).toBe(boom)
  })
})
