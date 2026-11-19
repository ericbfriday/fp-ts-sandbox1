import {
  all,
  err,
  flow,
  fromNullable,
  isResult,
  match,
  matchTag,
  ok,
  partition,
  pipe,
  type Result,
  tap,
  tapErr,
  unwrapOr
} from "@friday-friday/core"
import { describe, expect, it } from "vitest"
import { Forbidden, NotFound } from "./_fixtures.ts"

describe("constructors", () => {
  it("build plain data with no prototype tricks", () => {
    expect(ok(1)).toStrictEqual({ ok: true, value: 1 })
    expect(err("e")).toStrictEqual({ ok: false, error: "e" })
    expect(Object.getPrototypeOf(ok(1))).toBe(Object.prototype)
    expect(Object.getPrototypeOf(err(1))).toBe(Object.prototype)
  })
})

describe("isResult", () => {
  it("accepts both shapes", () => {
    expect(isResult(ok(1))).toBe(true)
    expect(isResult(err("e"))).toBe(true)
    expect(isResult({ ok: true, value: undefined })).toBe(true)
    expect(isResult(JSON.parse("{\"ok\":false,\"error\":null}"))).toBe(true)
  })

  it("rejects null, primitives, arrays, wrong discriminant and missing payload key", () => {
    expect(isResult(null)).toBe(false)
    expect(isResult(undefined)).toBe(false)
    expect(isResult(1)).toBe(false)
    expect(isResult("ok")).toBe(false)
    expect(isResult([])).toBe(false)
    expect(isResult([true, 1])).toBe(false)
    expect(isResult({})).toBe(false)
    expect(isResult({ ok: "x" })).toBe(false)
    expect(isResult({ ok: 1, value: 1 })).toBe(false)
    expect(isResult({ ok: true })).toBe(false)
    expect(isResult({ ok: true, error: "e" })).toBe(false)
    expect(isResult({ ok: false, value: 1 })).toBe(false)
  })
})

describe("fromNullable", () => {
  const onNone = (): NotFound => NotFound({ resource: "user", id: "1" })

  it("lifts a present value (including falsy ones) into Ok", () => {
    expect(fromNullable("x", onNone)).toStrictEqual(ok("x"))
    expect(fromNullable(0, onNone)).toStrictEqual(ok(0))
    expect(fromNullable("", onNone)).toStrictEqual(ok(""))
    expect(fromNullable(false, onNone)).toStrictEqual(ok(false))
  })

  it("builds the error lazily for null and undefined", () => {
    let calls = 0
    const counted = (): NotFound => {
      calls++
      return onNone()
    }
    expect(fromNullable(null, counted)).toStrictEqual(err(NotFound({ resource: "user", id: "1" })))
    expect(fromNullable(undefined, counted)).toStrictEqual(err(NotFound({ resource: "user", id: "1" })))
    expect(calls).toBe(2)
    fromNullable("present", counted)
    expect(calls).toBe(2)
  })

  it("is dual", () => {
    expect(fromNullable(onNone)("x")).toStrictEqual(fromNullable("x", onNone))
    expect(fromNullable(onNone)(null)).toStrictEqual(fromNullable(null, onNone))
  })
})

describe("unwrapOr", () => {
  it("returns the value or the fallback", () => {
    expect(unwrapOr(ok(1), 0)).toBe(1)
    expect(unwrapOr(err("e"), 0)).toBe(0)
    expect(unwrapOr(err("e"), undefined)).toBe(undefined)
    expect(unwrapOr(0)(ok(1))).toBe(1)
  })
})

describe("tap / tapErr", () => {
  it("run the side effect on the matching branch only and return the same object", () => {
    const seen: Array<unknown> = []
    const o = ok(1)
    const e = err("x")
    expect(tap(o, (v) => void seen.push(["tap", v]))).toBe(o)
    expect(tap(e, (v) => void seen.push(["tap", v]))).toBe(e)
    expect(tapErr(o, (v) => void seen.push(["tapErr", v]))).toBe(o)
    expect(tapErr(e, (v) => void seen.push(["tapErr", v]))).toBe(e)
    expect(seen).toStrictEqual([["tap", 1], ["tapErr", "x"]])
  })
})

describe("match", () => {
  it("dispatches on ok", () => {
    const handlers = { ok: (n: number) => `ok:${n}`, err: (e: string) => `err:${e}` }
    expect(match(ok(1), handlers)).toBe("ok:1")
    expect(match(err("boom"), handlers)).toBe("err:boom")
    expect(match(handlers)(ok(2))).toBe("ok:2")
    expect(pipe(err("z"), match(handlers))).toBe("err:z")
  })
})

describe("matchTag", () => {
  type E = NotFound | Forbidden
  const handlers = {
    ok: (n: number) => `ok:${n}`,
    NotFound: (e: NotFound) => `nf:${e.resource}/${e.id}`,
    Forbidden: (e: Forbidden) => `fb:${e.reason}`
  }

  it("dispatches on ok", () => {
    const okR: Result<number, E> = ok(1) // typed const, not `as`: a cast arg hits a TS7 inference quirk here
    expect(matchTag(okR, handlers)).toBe("ok:1")
  })

  it("dispatches on each _tag (data-last via pipe)", () => {
    const nf: Result<number, E> = err(NotFound({ resource: "user", id: "7" }))
    const fb: Result<number, E> = err(Forbidden({ reason: "nope" }))
    // Data-last forms only here: under TS 7.0.2, root `tsc` mis-resolves `T` for data-first matchTag
    // calls on tagged Results in test bodies (order-dependent, contradicts vitest's own typecheck —
    // a TS 7.0.2 bug, not a library bug; types.test-d covers data-first typing). Re-check with a
    // newer TS 7 patch and restore direct data-first calls.
    expect(pipe(nf, matchTag(handlers))).toBe("nf:user/7")
    expect(pipe(fb, matchTag(handlers))).toBe("fb:nope")
  })

  it("works data-last applied directly", () => {
    const fb: Result<number, E> = err(Forbidden({ reason: "nope" }))
    expect(matchTag(handlers)(fb)).toBe("fb:nope")
  })

  it("works on wire-decoded errors (no prototype needed)", () => {
    const wire: Result<number, E> = JSON.parse(JSON.stringify(err(NotFound({ resource: "post", id: "9" }))))
    expect(matchTag(wire, handlers)).toBe("nf:post/9")
  })
})

describe("all", () => {
  it("collects values in input order", () => {
    expect(all([ok(1), ok("a"), ok(true)])).toStrictEqual(ok([1, "a", true]))
    expect(all([])).toStrictEqual(ok([]))
  })

  it("returns the first Err in input order, as the same object", () => {
    const first = err("first")
    const second = err("second")
    const r = all([ok(1), first, ok(2), second])
    expect(r).toBe(first)
    expect(all([second, first])).toBe(second)
  })
})

describe("partition", () => {
  it("splits values and errors, each in input order", () => {
    const [values, errors] = partition([ok(1), err("a"), ok(2), err("b"), ok(3)])
    expect(values).toStrictEqual([1, 2, 3])
    expect(errors).toStrictEqual(["a", "b"])
    expect(partition([])).toStrictEqual([[], []])
  })
})

describe("pipe / flow", () => {
  it("pipe threads a value through functions left to right", () => {
    expect(pipe(1)).toBe(1)
    expect(pipe(1, (n) => n + 1)).toBe(2)
    expect(pipe(1, (n) => n + 1, (n) => n * 10, String, (s) => s + "!")).toBe("20!")
  })

  it("pipe supports 16 functions", () => {
    const inc = (n: number): number => n + 1
    expect(pipe(0, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc)).toBe(16)
  })

  it("flow composes left to right and forwards every argument to the first function", () => {
    const f = flow((a: number, b: number) => a + b, (n) => n * 2, String)
    expect(f(1, 2)).toBe("6")
    const g = flow((s: string) => s.length)
    expect(g("abc")).toBe(3)
  })

  it("flow supports 12 functions", () => {
    const inc = (n: number): number => n + 1
    const f = flow(inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc)
    expect(f(0)).toBe(12)
  })
})
