/**
 * `@friday-friday/schema` type tests: inference must flow from vendor schemas (zod fixture)
 * without any vendor import in the runtime surface.
 */
import type { Result } from "@friday-friday/core"
import {
  type Brand,
  type brand,
  branded,
  type IssueLike,
  parse,
  parseAsync,
  type StandardSchemaV1,
  toFieldErrors,
  toFormErrors,
  toValidationFailure,
  type ValidationFailure,
  type ValidationFailureLike,
  type ValidationIssue
} from "@friday-friday/schema"
import { type } from "arktype"
import * as v from "valibot"
import { describe, expectTypeOf, test } from "vitest"
import { z } from "zod"

describe("schema types", () => {
  test("parse infers the vendor output type", () => {
    const User = z.object({ id: z.string(), age: z.number() })
    const r = parse(User, { id: "1", age: 1 })
    expectTypeOf(r).toEqualTypeOf<Result<{ id: string; age: number }, ValidationFailure>>()
  })

  test("parseAsync mirrors parse", () => {
    const User = z.object({ id: z.string() })
    expectTypeOf(parseAsync(User, { id: "1" })).toEqualTypeOf<Promise<Result<{ id: string }, ValidationFailure>>>()
  })

  test("branded stamps the phantom brand type", () => {
    const parseUserId = branded(z.string(), "UserId")
    const r = parseUserId("u1")
    expectTypeOf(r).toEqualTypeOf<Result<Brand<string, "UserId">, ValidationFailure>>()
    if (r.ok) {
      // The brand key is present only at the type level.
      expectTypeOf(r.value).toExtend<{ [brand]: "UserId" }>()
    }
  })

  test("vendor output inference: valibot + arktype", () => {
    expectTypeOf(parse(v.object({ id: v.string() }), { id: "v" })).toEqualTypeOf<
      Result<{ id: string }, ValidationFailure>
    >()
    expectTypeOf(parse(type({ id: "string" }), { id: "a" })).toEqualTypeOf<Result<{ id: string }, ValidationFailure>>()
  })

  test("ValidationFailure shape is stable", () => {
    expectTypeOf<ValidationFailure["issues"][number]>().toEqualTypeOf<{
      readonly message: string
      readonly path: ReadonlyArray<string | number>
    }>()
  })

  test("toValidationFailure: Standard Schema or reader-shaped issues in, ValidationFailure out", () => {
    expectTypeOf(toValidationFailure).parameter(0).toEqualTypeOf<ReadonlyArray<IssueLike>>()
    expectTypeOf<ReadonlyArray<StandardSchemaV1.Issue>>().toExtend<ReadonlyArray<IssueLike>>()
    expectTypeOf<ValidationFailureLike["issues"]>().toExtend<ReadonlyArray<IssueLike>>()
    expectTypeOf(toValidationFailure).returns.toEqualTypeOf<ValidationFailure>()
    expectTypeOf<ValidationFailure["issues"][number]>().toEqualTypeOf<ValidationIssue>()
  })

  test("readers accept a ValidationFailure and a wire-rebuilt failure without paths", () => {
    expectTypeOf(toFieldErrors).toBeCallableWith(toValidationFailure([]))
    expectTypeOf(toFormErrors).toBeCallableWith({ issues: [{ message: "root" }] })
  })

  test("brand is a type-only export", () => {
    // @ts-expect-error -- `brand` has no runtime binding; it is usable in type positions only
    const key = brand
    expectTypeOf<Brand<string, "X">>().toExtend<{ readonly [brand]: "X" }>()
    return key
  })
})
