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
  type Result,
  tap,
  tapErr,
  unwrapOr
} from "@friday-friday/core"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { arbResult, arbTagged, type Forbidden, type NotFound, type Timeout } from "./_fixtures.js"

const arbFn = fc.func(fc.integer())
const arbKleisli = fc.func(arbResult)

describe("functor laws (map)", () => {
  it("identity: map(r, id) ≡ r", () => {
    fc.assert(fc.property(arbResult, (r) => {
      expect(map(r, (x) => x)).toStrictEqual(r)
    }))
  })

  it("composition: map(map(r, f), g) ≡ map(r, g ∘ f)", () => {
    fc.assert(fc.property(arbResult, arbFn, arbFn, (r, f, g) => {
      expect(map(map(r, f), g)).toStrictEqual(map(r, (x) => g(f(x))))
    }))
  })
})

describe("monad laws (andThen with ok as return)", () => {
  it("left identity: andThen(ok(a), f) ≡ f(a)", () => {
    fc.assert(fc.property(fc.integer(), arbKleisli, (a, f) => {
      expect(andThen(ok(a), f)).toStrictEqual(f(a))
    }))
  })

  it("right identity: andThen(r, ok) ≡ r", () => {
    fc.assert(fc.property(arbResult, (r) => {
      expect(andThen(r, ok)).toStrictEqual(r)
    }))
  })

  it("associativity: andThen(andThen(r, f), g) ≡ andThen(r, x => andThen(f(x), g))", () => {
    fc.assert(fc.property(arbResult, arbKleisli, arbKleisli, (r, f, g) => {
      expect(andThen(andThen(r, f), g)).toStrictEqual(andThen(r, (x) => andThen(f(x), g)))
    }))
  })
})

describe("dual-form equivalence: data-first ≡ data-last", () => {
  it("map", () => {
    fc.assert(fc.property(arbResult, arbFn, (r, f) => {
      expect(map(f)(r)).toStrictEqual(map(r, f))
    }))
  })

  it("mapErr", () => {
    const f = (e: string): number => e.length
    fc.assert(fc.property(arbResult, (r) => {
      expect(mapErr(f)(r)).toStrictEqual(mapErr(r, f))
    }))
  })

  it("andThen", () => {
    fc.assert(fc.property(arbResult, arbKleisli, (r, f) => {
      expect(andThen(f)(r)).toStrictEqual(andThen(r, f))
    }))
  })

  it("orElse", () => {
    const f = (e: string): Result<number, boolean> => e.length > 3 ? ok(e.length) : err(false)
    fc.assert(fc.property(arbResult, (r) => {
      expect(orElse(f)(r)).toStrictEqual(orElse(r, f))
    }))
  })

  it("tap / tapErr (same object back, same effects)", () => {
    fc.assert(fc.property(arbResult, (r) => {
      const a: Array<unknown> = []
      const b: Array<unknown> = []
      expect(tap((v) => void a.push(v))(r)).toBe(tap(r, (v) => void b.push(v)))
      expect(tapErr((e) => void a.push(e))(r)).toBe(tapErr(r, (e) => void b.push(e)))
      expect(a).toStrictEqual(b)
    }))
  })

  it("unwrapOr", () => {
    fc.assert(fc.property(arbResult, fc.integer(), (r, d) => {
      expect(unwrapOr(d)(r)).toBe(unwrapOr(r, d))
    }))
  })

  it("match", () => {
    fc.assert(fc.property(arbResult, arbFn, (r, f) => {
      const handlers = { ok: f, err: (e: string) => e.length }
      expect(match(handlers)(r)).toBe(match(r, handlers))
    }))
  })

  it("matchTag", () => {
    const arb: fc.Arbitrary<Result<number, NotFound | Forbidden | Timeout>> = fc.oneof(
      fc.integer().map((n) => ok(n)),
      arbTagged.map((e) => err(e))
    )
    const handlers = {
      ok: (n: number) => `ok:${n}`,
      NotFound: (e: NotFound) => `nf:${e.id}`,
      Forbidden: (e: Forbidden) => `fb:${e.reason}`,
      Timeout: () => "to"
    }
    fc.assert(fc.property(arb, (r) => {
      expect(matchTag(handlers)(r)).toBe(matchTag(r, handlers))
    }))
  })

  it("fromNullable", () => {
    const onNone = (): string => "none"
    fc.assert(fc.property(fc.option(fc.integer(), { nil: undefined }), (v) => {
      expect(fromNullable(onNone)(v)).toStrictEqual(fromNullable(v, onNone))
    }))
  })
})
