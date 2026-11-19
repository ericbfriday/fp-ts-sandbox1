/**
 * Type tests for the fixed vocabulary (ADR-0005, #87): each factory's props, exactly, all optional.
 * Each assertion calls the factory, so a factory typed `any` or with an extra/required prop fails.
 * `.branded`: the factories return `TaggedError<Tag> & Readonly<P>`, and only the deep-structural
 * comparison equates that intersection with the flat shape written here.
 */
import {
  type AsyncResult,
  Conflict,
  DbUnavailable,
  err,
  type ErrorFactory,
  Forbidden,
  NetworkError,
  NotFound,
  taggedError,
  Timeout,
  Unauthenticated
} from "@friday-friday/core"
import * as Async from "@friday-friday/core/async"
import { timeout, type TimeoutFn } from "@friday-friday/core/async"
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

describe("taggedError enforces ADR-0005 on fixed tags (#92)", () => {
  test("a required prop on a fixed tag is a compile error", () => {
    // @ts-expect-error -- `id` must be optional: "NotFound" is a fixed tag
    taggedError("NotFound")<{ id: string }>()
    // @ts-expect-error -- `required` must be optional: "Forbidden" is a fixed tag
    taggedError("Forbidden")<{ readonly required: string }>()
    // @ts-expect-error -- an extension prop must be optional too
    taggedError("Unauthenticated")<{ where: string }>()
    // @ts-expect-error -- infrastructure tags follow the same rule
    taggedError("DbUnavailable")<{ host: string }>()
  })

  test("a retyped core prop is a compile error", () => {
    // @ts-expect-error -- `id` must keep core's "NotFound" type (string)
    taggedError("NotFound")<{ id?: number }>()
    // @ts-expect-error -- `ms` must keep core's "Timeout" type (number)
    taggedError("Timeout")<{ readonly ms?: string }>()
  })

  test("optional extension props compile and keep the fixed tag", () => {
    const Extended: ErrorFactory<"NotFound", { readonly id?: string; readonly table?: string }> = taggedError(
      "NotFound"
    )<{ readonly id?: string; readonly table?: string }>()
    expectTypeOf(Extended.tag).toEqualTypeOf<"NotFound">()
    expectTypeOf(Extended({ table: "users" }).table).toEqualTypeOf<string | undefined>()
    // Core's own factories pass their own rule; `{}` and no type argument compile.
    expectTypeOf(taggedError("Unauthenticated")()).toEqualTypeOf<ErrorFactory<"Unauthenticated", {}>>()
    expectTypeOf(taggedError("Conflict")<{}>()).toEqualTypeOf<ErrorFactory<"Conflict", {}>>()
  })

  test("schema's ValidationFailure may (must) require `issues`", () => {
    taggedError("ValidationFailure")<{ issues: ReadonlyArray<{ message: string; path: ReadonlyArray<string> }> }>()
    // @ts-expect-error -- `issues` is required by "ValidationFailure"
    taggedError("ValidationFailure")<{ issues?: [] }>()
    // @ts-expect-error -- `issues` must keep core's "ValidationFailure" type
    taggedError("ValidationFailure")<{ issues: ReadonlyArray<string> }>()
  })

  test("app and adapter tags may still require props", () => {
    const PaymentDeclined: ErrorFactory<"PaymentDeclined", { reason: string }> = taggedError("PaymentDeclined")<
      { reason: string }
    >()
    expectTypeOf(PaymentDeclined({ reason: "card" }).reason).toEqualTypeOf<string>()
    expectTypeOf(taggedError("HttpError")<{ status: number }>()).toEqualTypeOf<
      ErrorFactory<"HttpError", { status: number }>
    >()
  })
})

describe("/async does not re-export Timeout (contract step, #92)", () => {
  test("Timeout comes from core root only; timeout() still unions core's Timeout into E", () => {
    expectTypeOf(Async).not.toHaveProperty("Timeout")
    expectTypeOf(timeout).toEqualTypeOf<TimeoutFn>()
    const slow = async (): AsyncResult<number, "slow"> => err("slow")
    expectTypeOf(timeout(slow, 5)).toEqualTypeOf<AsyncResult<number, "slow" | Timeout>>()
  })
})
