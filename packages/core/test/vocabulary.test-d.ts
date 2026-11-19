/**
 * Type tests for the fixed vocabulary (ADR-0005, #87): each factory's props, exactly, all optional.
 * Each assertion calls the factory, so a factory typed `any` or with an extra/required prop fails.
 * `.branded`: the factories return `TaggedError<Tag> & Readonly<P>`, and only the deep-structural
 * comparison equates that intersection with the flat shape written here.
 */
import {
  Conflict,
  DbUnavailable,
  Forbidden,
  NetworkError,
  NotFound,
  Timeout,
  Unauthenticated
} from "@friday-friday/core"
import { Timeout as AsyncTimeout, timeout, type TimeoutFn } from "@friday-friday/core/async"
import { describe, expectTypeOf, test } from "vitest"

describe("fixed-vocabulary factories: exactly the ADR-0005 props, every one optional", () => {
  test("NotFound { resource?, id? }", () => {
    expectTypeOf(NotFound({})).branded.toEqualTypeOf<
      { readonly _tag: "NotFound"; readonly message?: string; readonly resource?: string; readonly id?: string }
    >()
    expectTypeOf(NotFound({})).toEqualTypeOf<NotFound>()
  })

  test("Conflict { field?, constraint? }", () => {
    expectTypeOf(Conflict({})).branded.toEqualTypeOf<
      { readonly _tag: "Conflict"; readonly message?: string; readonly field?: string; readonly constraint?: string }
    >()
    expectTypeOf(Conflict({})).toEqualTypeOf<Conflict>()
  })

  test("Forbidden { required? }", () => {
    expectTypeOf(Forbidden({})).branded.toEqualTypeOf<
      { readonly _tag: "Forbidden"; readonly message?: string; readonly required?: string }
    >()
    expectTypeOf(Forbidden({})).toEqualTypeOf<Forbidden>()
  })

  test("Unauthenticated {}", () => {
    expectTypeOf(Unauthenticated({})).branded.toEqualTypeOf<
      { readonly _tag: "Unauthenticated"; readonly message?: string }
    >()
    expectTypeOf(Unauthenticated({})).toEqualTypeOf<Unauthenticated>()
  })

  test("Timeout { ms? }", () => {
    expectTypeOf(Timeout({})).branded.toEqualTypeOf<
      { readonly _tag: "Timeout"; readonly message?: string; readonly ms?: number }
    >()
    expectTypeOf(Timeout({})).toEqualTypeOf<Timeout>()
  })

  test("NetworkError { reason? }", () => {
    expectTypeOf(NetworkError({})).branded.toEqualTypeOf<
      { readonly _tag: "NetworkError"; readonly message?: string; readonly reason?: string }
    >()
    expectTypeOf(NetworkError({})).toEqualTypeOf<NetworkError>()
  })

  test("DbUnavailable {}", () => {
    expectTypeOf(DbUnavailable({})).branded.toEqualTypeOf<
      { readonly _tag: "DbUnavailable"; readonly message?: string }
    >()
    expectTypeOf(DbUnavailable({})).toEqualTypeOf<DbUnavailable>()
  })

  test("a prop outside the vocabulary is rejected; props keep their JSON-safe types", () => {
    // @ts-expect-error -- `reason` is db's old NotFound prop, not core's
    NotFound({ reason: "missing" })
    // @ts-expect-error -- `id` is a string
    NotFound({ id: 42 })
    // @ts-expect-error -- `ms` is a number
    Timeout({ ms: "500" })
  })
})

describe("/async's Timeout twin is core root's (expand step)", () => {
  test("same factory type, same error type; timeout() is still TimeoutFn and unions it into E", () => {
    expectTypeOf(AsyncTimeout).toEqualTypeOf(Timeout)
    expectTypeOf(AsyncTimeout({ ms: 1 })).toEqualTypeOf<Timeout>()
    expectTypeOf<AsyncTimeout>().toEqualTypeOf<Timeout>()
    expectTypeOf(timeout).toEqualTypeOf<TimeoutFn>()
  })
})
