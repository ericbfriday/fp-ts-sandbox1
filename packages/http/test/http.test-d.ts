/**
 * `@friday-friday/http` type tests: the timeout arm of `FetchError` is core's own `Timeout`
 * twin (RFC-0001 §2), not a local re-derivation (#64).
 */
import type { Timeout } from "@friday-friday/core/async"
import type { FetchError } from "@friday-friday/http"
import { describe, expectTypeOf, test } from "vitest"

describe("http types", () => {
  test("FetchError's Timeout arm is core/async's Timeout type", () => {
    expectTypeOf<Extract<FetchError, { readonly _tag: "Timeout" }>>().toEqualTypeOf<Timeout>()
  })
})
