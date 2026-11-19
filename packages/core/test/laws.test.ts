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
import { arbResult, arbTagged, type Forbidden, type NotFound, type Timeout } from "./_fixtures.ts"

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

/**
 * One property over every dual export (IDEA §8). All nine share the internal `dual` helper, so
 * nine separate properties re-proved one fact (#61). This drives each export through its public
 * signature: a combinator that drops `dual` for a hand-rolled dispatch must still agree.
 * Identity and call order of `tap`/`tapErr` are pinned in result.test.ts.
 */
type DualCase = readonly [name: string, dataFirst: () => unknown, dataLast: () => unknown]

const arbTaggedResult: fc.Arbitrary<Result<number, NotFound | Forbidden | Timeout>> = fc.oneof(
  fc.integer().map((n) => ok(n)),
  arbTagged.map((e) => err(e))
)
const tagHandlers = {
  ok: (n: number) => `ok:${n}`,
  NotFound: (e: NotFound) => `nf:${e.id}`,
  Forbidden: (e: Forbidden) => `fb:${e.reason}`,
  Timeout: () => "to"
}
const errLength = (e: string): number => e.length
const recover = (e: string): Result<number, boolean> => e.length > 3 ? ok(e.length) : err(false)
const onNone = (): string => "none"

const arbDualCase: fc.Arbitrary<DualCase> = fc.oneof(
  fc.tuple(arbResult, arbFn).map(([r, f]): DualCase => ["map", () => map(r, f), () => map(f)(r)]),
  arbResult.map((r): DualCase => ["mapErr", () => mapErr(r, errLength), () => mapErr(errLength)(r)]),
  fc.tuple(arbResult, arbKleisli).map(([r, f]): DualCase => ["andThen", () => andThen(r, f), () => andThen(f)(r)]),
  arbResult.map((r): DualCase => ["orElse", () => orElse(r, recover), () => orElse(recover)(r)]),
  arbResult.map((r): DualCase => ["tap", () => tap(r, () => {}), () => tap(() => {})(r)]),
  arbResult.map((r): DualCase => ["tapErr", () => tapErr(r, () => {}), () => tapErr(() => {})(r)]),
  fc.tuple(arbResult, fc.integer()).map(([r, d]): DualCase => ["unwrapOr", () => unwrapOr(r, d), () => unwrapOr(d)(r)]),
  fc.tuple(arbResult, arbFn).map(([r, f]): DualCase => {
    const h = { ok: f, err: errLength }
    return ["match", () => match(r, h), () => match(h)(r)]
  }),
  arbTaggedResult.map((r): DualCase => ["matchTag", () => matchTag(r, tagHandlers), () => matchTag(tagHandlers)(r)]),
  fc.option(fc.integer(), { nil: undefined }).map((v): DualCase => [
    "fromNullable",
    () => fromNullable(v, onNone),
    () => fromNullable(onNone)(v)
  ])
)

describe("dual-form equivalence", () => {
  it("every dual export: f(arg)(r) ≡ f(r, arg)", () => {
    fc.assert(
      fc.property(arbDualCase, ([name, dataFirst, dataLast]) => {
        expect(dataLast(), name).toStrictEqual(dataFirst())
      }),
      { numRuns: 1000 }
    ) // ~100 per export, as the nine separate properties ran
  })
})
