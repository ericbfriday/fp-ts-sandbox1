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

  it("the factory owns _tag: a _tag smuggled in through props is ignored at runtime (#60)", () => {
    // The repro: a Conflict's fields used as NotFound's props. A typed `_tag` prop is now a type
    // error (types.test-d.ts), so the props come untyped, as off-the-wire data would arrive.
    const smuggled: { resource: string; id: string } = JSON.parse(
      "{\"_tag\":\"Conflict\",\"resource\":\"u\",\"id\":\"1\"}"
    )
    const e = NotFound(smuggled)
    expect(e._tag).toBe("NotFound")
    expect(NotFound.is(e)).toBe(true)
    expect(e).toStrictEqual({ _tag: "NotFound", resource: "u", id: "1" })
    // `_tag` stays the first key, so JSON output is unchanged for every well-formed call.
    expect(JSON.stringify(e)).toBe("{\"_tag\":\"NotFound\",\"resource\":\"u\",\"id\":\"1\"}")
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

  // #53, RFC-0001 §2: React's dev Flight serializer sends an Error's `cause` to the browser
  // whenever `"cause" in error` (emitErrorChunk / serializeErrorValue in next 16.4.6's compiled
  // react-server-dom-webpack), enumerable or not, so the thrown Error must not have one at all.
  it("never puts the server-only cause on the thrown Error; it stays on data, and a missing message is tolerated", () => {
    const cause = new Error("db down")
    const e = NotFound({ resource: "user", id: "1", cause })
    const t = toThrowable(e)
    expect("cause" in t).toBe(false)
    expect(t.data).toBe(e)
    expect(t.data).toHaveProperty("cause", cause)
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
    ["a plain object", { a: 1 }, "Non-Error thrown"],
    [
      "a tagged error with a message",
      NotFound({ resource: "user", id: "1", message: "no such user" }),
      "NotFound: no such user"
    ],
    ["a tagged error without a message", NotFound({ resource: "user", id: "1" }), "NotFound"],
    ["a tagged error carrying a cause", { _tag: "NotFound", message: "m", cause: "secret" }, "NotFound: m"],
    ["an object with only a message", { message: "upstream said no" }, "upstream said no"],
    ["an object with only a name", { name: "AbortError" }, "AbortError"],
    ["an Error with an empty message", new TypeError(""), "TypeError"],
    ["an array", [1, "two"], "Non-Error thrown"],
    ["a null-prototype object", Object.create(null), "Non-Error thrown"],
    ["an anonymous function", Object.defineProperty(() => 1, "name", { value: "" }), "Non-Error thrown"],
    ["a number", 42, "42"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a symbol", Symbol("s"), "Symbol(s)"],
    ["a bigint (not JSON-safe)", 10n, "10"]
  ])("built from %s, Panic has a short readable message, never [object Object]", (_name, cause, message) => {
    const p = new Panic(cause)
    expect(p.message).toBe(message)
    expect(p.cause).toBe(cause)
  })

  it("never dumps a plain object's data into the message (secrets stay on .cause only)", () => {
    const cause = { dsn: "postgres://admin:hunter2@db", nested: { token: "sk_live_x" } }
    const p = new Panic(cause)
    expect(p.message).not.toContain("hunter2")
    expect(p.message).not.toContain("sk_live_x")
    expect(p.message).not.toContain("[object Object]")
    expect(p.cause).toBe(cause)
  })

  it.each<[string, unknown]>([
    ["a huge plain object", { data: "x".repeat(1e6) }],
    ["a huge string", "x".repeat(1e6)],
    ["a huge Error message", new Error("x".repeat(1e6))],
    ["a huge tagged error message", { _tag: "Big", message: "x".repeat(1e6) }]
  ])("caps the message length (200 chars) for %s; the full value stays on .cause", (_name, cause) => {
    const p = new Panic(cause)
    expect(p.message.length).toBeLessThanOrEqual(200)
    expect(p.cause).toBe(cause)
  })

  it("built from a cyclic plain object, Panic still constructs with a short message", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const p = new Panic(cyclic)
    expect(p.cause).toBe(cyclic)
    expect(p.message).toBe("Non-Error thrown")
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

  it("matchTag with no handler for the runtime tag panics with a message naming the tag (#60)", () => {
    const handlers = { ok: () => 0, NotFound: () => 1, Forbidden: () => 2 }
    const fromWire = (tag: string): Result<number, NotFoundT | Forbidden> =>
      JSON.parse(JSON.stringify({ ok: false, error: { _tag: tag } }))
    const p = capturePanic(() => matchTag(fromWire("Conflict"), handlers))
    expect(p.message).toBe("matchTag: no handler for _tag Conflict")
    expect(p.message).not.toMatch(/is not a function/)
    // Data-last takes the same path.
    expect(capturePanic(() => matchTag(handlers)(fromWire("Conflict"))).message).toBe(
      "matchTag: no handler for _tag Conflict"
    )
    // Only own handlers count: inherited Object.prototype members and the `ok` handler are not
    // error handlers, so a wire tag that happens to name one still panics instead of misdispatching.
    for (const tag of ["constructor", "toString", "hasOwnProperty", "__proto__", "ok"]) {
      expect(capturePanic(() => matchTag(fromWire(tag), handlers)).message).toBe(
        `matchTag: no handler for _tag ${tag}`
      )
    }
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
