/**
 * `@friday-friday/http` type tests: the transport arms of `FetchError` are core's own fixed
 * vocabulary (ADR-0005, #90), not local re-derivations (#64).
 */
import type { NetworkError, Timeout } from "@friday-friday/core"
import type { FetchError, HttpError } from "@friday-friday/http"
import type { ValidationFailure } from "@friday-friday/schema"
import { describe, expectTypeOf, test } from "vitest"

describe("http types", () => {
  test("FetchError's Timeout arm is core root's Timeout type", () => {
    expectTypeOf<Extract<FetchError, { readonly _tag: "Timeout" }>>().toEqualTypeOf<Timeout>()
  })

  test("FetchError's NetworkError arm is core's NetworkError, so `reason` is optional", () => {
    expectTypeOf<Extract<FetchError, { readonly _tag: "NetworkError" }>>().toEqualTypeOf<NetworkError>()
    expectTypeOf<Extract<FetchError, { readonly _tag: "NetworkError" }>["reason"]>().toEqualTypeOf<
      string | undefined
    >()
  })

  test("FetchError is exactly the adapter tag plus core's and schema's types", () => {
    expectTypeOf<FetchError>().toEqualTypeOf<HttpError | NetworkError | Timeout | ValidationFailure>()
  })
})
