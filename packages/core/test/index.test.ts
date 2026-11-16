import { andThen, err, map, ok, pipe, type Result } from "@friday-friday/core"
import * as fc from "fast-check"
import { describe, expect, expectTypeOf, it } from "vitest"

describe("core scaffold stub", () => {
  it("builds plain-data results", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 })
    expect(err("e")).toEqual({ ok: false, error: "e" })
  })

  it("map/andThen/pipe compose", () => {
    const r = pipe(ok(1), (x) => andThen(map(x, (n) => n + 1), (n) => ok(n * 2)))
    expect(r).toEqual({ ok: true, value: 4 })
  })

  it("types narrow on ok", () => {
    const r = ((): Result<number, string> => ok(1))()
    if (r.ok) expectTypeOf(r.value).toEqualTypeOf<number>()
    else expectTypeOf(r.error).toEqualTypeOf<string>()
  })

  it("functor identity law + JSON round-trip (fast-check wiring)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer().map(ok), fc.string().map(err)), (r) => {
        expect(map(r, (x) => x)).toEqual(r)
        expect(JSON.parse(JSON.stringify(r))).toEqual(r)
        expect(structuredClone(r)).toEqual(r)
      })
    )
  })
})
