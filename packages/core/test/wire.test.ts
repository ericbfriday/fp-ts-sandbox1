/**
 * RFC-0001 §5 contract: `JSON.parse(JSON.stringify(r))` deep-equals `r` and `structuredClone(r)`
 * deep-equals `r` for every public constructor and combinator output, and for tagged errors.
 */
import {
  all,
  andThen,
  err,
  fromNullable,
  isResult,
  map,
  mapErr,
  match,
  matchTag,
  ok,
  orElse,
  partition,
  type Result,
  tap,
  tapErr,
  trySync,
  unwrapOr
} from "@friday-friday/core"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { arbJsonResult, arbNotFound, arbTagged, arbTaggedResult, jsonValue, NotFound } from "./_fixtures.ts"

const roundTrips = (x: unknown): void => {
  expect(JSON.parse(JSON.stringify(x))).toStrictEqual(x)
  expect(structuredClone(x)).toStrictEqual(x)
}

describe("wire stability", () => {
  it("ok / err", () => {
    fc.assert(fc.property(arbJsonResult, (r) => {
      roundTrips(r)
      expect(isResult(JSON.parse(JSON.stringify(r)))).toBe(true)
      expect(isResult(structuredClone(r))).toBe(true)
    }))
  })

  it("map / mapErr / andThen / orElse outputs", () => {
    fc.assert(fc.property(arbJsonResult, jsonValue, (r, v) => {
      roundTrips(map(r, () => v))
      roundTrips(mapErr(r, () => v))
      roundTrips(andThen(r, () => ok(v)))
      roundTrips(andThen(r, () => err(v)))
      roundTrips(orElse(r, () => ok(v)))
      roundTrips(orElse(r, () => err(v)))
    }))
  })

  it("tap / tapErr outputs", () => {
    fc.assert(fc.property(arbJsonResult, (r) => {
      roundTrips(tap(r, () => {}))
      roundTrips(tapErr(r, () => {}))
    }))
  })

  it("fromNullable outputs (both branches)", () => {
    fc.assert(fc.property(fc.option(jsonValue, { nil: null }), arbNotFound, (v, e) => {
      roundTrips(fromNullable(v, () => e))
    }))
  })

  it("all / partition outputs", () => {
    fc.assert(fc.property(fc.array(arbJsonResult, { maxLength: 6 }), (rs) => {
      roundTrips(all(rs))
      roundTrips(partition(rs))
    }))
  })

  it("match / matchTag / unwrapOr outputs", () => {
    fc.assert(
      fc.property(arbJsonResult, jsonValue, arbTaggedResult, (r, v, rTagged) => {
        roundTrips(match(r, { ok: () => v, err: () => v }))
        roundTrips(unwrapOr(r, v))
        roundTrips(matchTag(rTagged, { ok: () => v, NotFound: () => v, Forbidden: () => v, Timeout: () => v }))
      })
    )
  })

  it("trySync outputs: success and mapped error", () => {
    fc.assert(
      fc.property(jsonValue, jsonValue, (value, error) => {
        roundTrips(
          trySync(() => value, {
            catch: () => "mapped"
          })
        )
        roundTrips(
          trySync((): unknown => {
            throw error
          }, { catch: (cause: unknown) => cause })
        )
      })
    )
  })

  it("tagged errors, bare and inside Err", () => {
    fc.assert(fc.property(arbTagged, (e) => {
      roundTrips(e)
      roundTrips(err(e))
      expect(NotFound.is(JSON.parse(JSON.stringify(e)))).toBe(NotFound.is(e))
      expect(NotFound.is(structuredClone(e))).toBe(NotFound.is(e))
    }))
  })

  it("decoded Results narrow and dispatch like fresh ones", () => {
    const r: Result<number, NotFound> = err(NotFound({ resource: "user", id: "1", message: "gone" }))
    const wire: unknown = JSON.parse(JSON.stringify(r))
    expect(isResult(wire)).toBe(true)
    if (isResult(wire) && !wire.ok && NotFound.is(wire.error)) {
      expect(wire.error.id).toBe("1")
      expect(wire.error.message).toBe("gone")
    } else {
      expect.unreachable("wire Result did not narrow")
    }
  })
})
