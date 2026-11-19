/**
 * `/gen` type tests (RFC-0001 §4).
 *
 * Multi-step bodies annotate the generator's return type (`Generator<Err<E>, T, unknown>`) —
 * TS 7.0.2 widens Y to `unknown` when a body yields generators with differently-typed `T`
 * without it. Single-source bodies infer without annotation (see the second test).
 */
import { type AsyncResult, type Err, err, NotFound, ok, type Result } from "@friday-friday/core"
import { $, gen, genAsync } from "@friday-friday/core/gen"
import { describe, expectTypeOf, test } from "vitest"

type NotFoundT = ReturnType<typeof NotFound>

describe("gen types", () => {
  test("gen infers T and E from an annotated generator body", () => {
    expectTypeOf(gen(function*(): Generator<Err<NotFoundT>, string, unknown> {
      const a: number = yield* $(ok(1))
      const b: string = yield* $(err(NotFound({ id: "1" })))
      return `${a}${b}`
    })).toEqualTypeOf<Result<string, NotFoundT>>()
  })

  test("single-source bodies infer without annotation", () => {
    expectTypeOf(gen(function*() {
      const b: string = yield* $(err(NotFound({ id: "1" })))
      return b
    })).toEqualTypeOf<Result<string, NotFoundT>>()
  })

  test("genAsync infers T and E from the async generator body", () => {
    expectTypeOf(genAsync(async function*(): AsyncGenerator<Err<NotFoundT>, number, unknown> {
      const a: number = yield* $(await Promise.resolve(ok(1)))
      return a + 1
    })).toEqualTypeOf<AsyncResult<number, NotFoundT>>()
  })
})
