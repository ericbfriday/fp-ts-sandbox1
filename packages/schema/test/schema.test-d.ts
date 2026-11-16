/**
 * `@friday-friday/schema` type tests: inference must flow from vendor schemas (zod fixture)
 * without any vendor import in the runtime surface.
 */
import type { Result } from "@friday-friday/core"
import { type Brand, type brand, branded, parse, parseAsync, type ValidationFailure } from "@friday-friday/schema"
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
    const r: Promise<Result<{ id: string }, ValidationFailure>> = parseAsync(User, { id: "1" })
    expectTypeOf(r).toEqualTypeOf<Promise<Result<{ id: string }, ValidationFailure>>>()
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
    const vr: Result<{ id: string }, ValidationFailure> = parse(v.object({ id: v.string() }), { id: "v" })
    expectTypeOf(vr).toEqualTypeOf<Result<{ id: string }, ValidationFailure>>()
    const ar: Result<{ id: string }, ValidationFailure> = parse(type({ id: "string" }), { id: "a" })
    expectTypeOf(ar).toEqualTypeOf<Result<{ id: string }, ValidationFailure>>()
  })

  test("ValidationFailure shape is stable", () => {
    expectTypeOf<ValidationFailure["issues"][number]>().toEqualTypeOf<{
      readonly message: string
      readonly path: ReadonlyArray<string | number>
    }>()
  })
})
