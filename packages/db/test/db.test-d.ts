/**
 * `@friday-friday/db` type tests: each mapper's return union is exactly the tags it can
 * produce (plus `null`), and props are schema names only — no `detail` slot to leak into.
 */
import {
  type Conflict,
  type ForeignKeyViolation,
  mapDbError,
  type MappedDbError,
  mapPgError,
  mapPrismaError,
  type NotFound,
  NotNullViolation
} from "@friday-friday/db"
import { describe, expectTypeOf, it } from "vitest"

describe("mapper return types", () => {
  it("mapPgError: Conflict | ForeignKeyViolation | NotNullViolation | null", () => {
    const r: Conflict | ForeignKeyViolation | NotNullViolation | null = mapPgError(undefined)
    expectTypeOf(mapPgError).returns.toEqualTypeOf<Conflict | ForeignKeyViolation | NotNullViolation | null>()
    expectTypeOf(r).not.toBeAny()
  })

  it("mapPrismaError: Conflict | ForeignKeyViolation | NotFound | null", () => {
    expectTypeOf(mapPrismaError).returns.toEqualTypeOf<Conflict | ForeignKeyViolation | NotFound | null>()
  })

  it("mapDbError: MappedDbError | null, dispatchable on _tag", () => {
    expectTypeOf(mapDbError).returns.toEqualTypeOf<MappedDbError | null>()
    expectTypeOf<MappedDbError["_tag"]>().toEqualTypeOf<
      "Conflict" | "ForeignKeyViolation" | "NotNullViolation" | "NotFound"
    >()
  })
})

describe("props", () => {
  it("integrity violations expose constraint/column, and no detail", () => {
    expectTypeOf<ForeignKeyViolation["constraint"]>().toEqualTypeOf<string | undefined>()
    expectTypeOf<NotNullViolation["column"]>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Conflict>().not.toHaveProperty("detail")
    expectTypeOf<ForeignKeyViolation>().not.toHaveProperty("detail")
    // @ts-expect-error -- `detail` is not a prop: row values stay on `cause`
    NotNullViolation({ detail: "Failing row contains (2, 1, null)." })
  })
})
