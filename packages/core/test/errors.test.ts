import {
  andThen,
  err,
  fromNullable,
  map,
  mapErr,
  match,
  matchTag,
  ok,
  orElse,
  Panic,
  type Result,
  taggedError,
  tap,
  tapErr,
  toThrowable
} from "@friday-friday/core"
import { describe, expect, it } from "vitest"
import { type Forbidden, NotFound, type NotFound as NotFoundT, Timeout } from "./_fixtures.js"

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
  const tagged: Result<number, NotFoundT | Forbidden> = err(NotFound({ resource: "user", id: "1" }))
  const okTagged: Result<number, NotFoundT | Forbidden> = ok(1)
  const throwing = (): never => {
    throw boom
  }

  const cases: Array<[string, () => unknown]> = [
    ["map", () => map(r, throwing)],
    ["map (data-last)", () => map(throwing)(r)],
    ["mapErr", () => mapErr(e, throwing)],
    ["andThen", () => andThen(r, throwing)],
    ["orElse", () => orElse(e, throwing)],
    ["tap", () => tap(r, throwing)],
    ["tapErr", () => tapErr(e, throwing)],
    ["match ok", () => match(r, { ok: throwing, err: () => 0 })],
    ["match err", () => match(e, { ok: () => 0, err: throwing })],
    ["matchTag ok", () => matchTag(okTagged, { ok: throwing, NotFound: () => 0, Forbidden: () => 0 })],
    ["matchTag tag", () => matchTag(tagged, { ok: () => 0, NotFound: throwing, Forbidden: () => 0 })],
    ["fromNullable", () => fromNullable(null, throwing)]
  ]

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

  it.each(cases)("%s: a throwing callback is rethrown as Panic with the original as cause", (_name, run) => {
    const p = capturePanic(run)
    expect(p).toBeInstanceOf(Error)
    expect(p.name).toBe("Panic")
    expect(p.cause).toBe(boom)
    expect(p.message).toBe("boom")
    expect(String(p)).toBe("Panic: boom")
  })

  it("wraps non-Error throws too", () => {
    const p = capturePanic(() =>
      map(r, () => {
        throw "plain string"
      })
    )
    expect(p.cause).toBe("plain string")
    expect(p.message).toBe("plain string")
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
