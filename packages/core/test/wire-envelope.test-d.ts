import { taggedError } from "@friday-friday/core"
import {
  fromWire,
  type InternalDefect,
  type Json,
  type Problem,
  PROBLEM_CONTENT_TYPE,
  sanitize,
  type StatusMap,
  toDefect,
  toProblem,
  type WireError
} from "@friday-friday/core/wire"
import { describe, expectTypeOf, it } from "vitest"

const NotFound = taggedError("NotFound")<{ id: string }>()

describe("@friday-friday/core/wire types", () => {
  it("sanitize keeps the literal tag", () => {
    expectTypeOf(sanitize(NotFound({ id: "1" }))).toEqualTypeOf<WireError<"NotFound">>()
    expectTypeOf(sanitize(NotFound({ id: "1" }))._tag).toEqualTypeOf<"NotFound">()
  })

  it("toProblem accepts a number, a status map, or nothing", () => {
    expectTypeOf(toProblem(NotFound({ id: "1" }))).toEqualTypeOf<Problem>()
    expectTypeOf(toProblem).toBeCallableWith(NotFound({ id: "1" }), 404)
    // adapter status maps with literal values (hono `StatusMap<E>`, next `StatusMap`) are assignable
    const literal = { NotFound: 404, Conflict: 409 } as const
    expectTypeOf(literal).toExtend<StatusMap>()
    expectTypeOf(toProblem).toBeCallableWith(NotFound({ id: "1" }), literal)
  })

  it("fromWire takes unknown and may fail", () => {
    expectTypeOf(fromWire).parameter(0).toEqualTypeOf<unknown>()
    expectTypeOf(fromWire({})).toEqualTypeOf<WireError | undefined>()
  })

  it("toDefect returns the fixed envelope", () => {
    expectTypeOf(toDefect(new Error("x"))).toEqualTypeOf<InternalDefect>()
    expectTypeOf(toDefect(new Error("x")).message).toEqualTypeOf<"Internal server error">()
    expectTypeOf(PROBLEM_CONTENT_TYPE).toEqualTypeOf<"application/problem+json">()
  })

  it("every output is Json-typed", () => {
    expectTypeOf(toProblem(NotFound({ id: "1" }))).toExtend<{ readonly [member: string]: Json | undefined }>()
  })
})
