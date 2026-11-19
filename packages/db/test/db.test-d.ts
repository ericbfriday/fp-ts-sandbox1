/**
 * `@friday-friday/db` type tests: each mapper's return union is exactly the tags it can
 * produce (plus `null`), and props are schema names only — no `detail` slot to leak into.
 * The fixed tags (`Conflict`, `NotFound`, `DbUnavailable`) are core's types (ADR-0005).
 */
import { type Conflict, type DbUnavailable, NotFound } from "@friday-friday/core"
import type * as db from "@friday-friday/db"
import {
  type ForeignKeyViolation,
  mapDbError,
  type MappedDbError,
  mapPgError,
  mapPrismaError,
  NotNullViolation
} from "@friday-friday/db"
import { describe, expectTypeOf, it } from "vitest"

describe("mapper return types", () => {
  it("mapPgError: Conflict | ForeignKeyViolation | NotNullViolation | DbUnavailable | null", () => {
    expectTypeOf(mapPgError(undefined)).toEqualTypeOf<
      Conflict | ForeignKeyViolation | NotNullViolation | DbUnavailable | null
    >()
  })

  it("mapPrismaError: Conflict | ForeignKeyViolation | NotFound | DbUnavailable | null", () => {
    expectTypeOf(mapPrismaError).returns.toEqualTypeOf<
      Conflict | ForeignKeyViolation | NotFound | DbUnavailable | null
    >()
  })

  it("mapDbError: MappedDbError | null, dispatchable on _tag", () => {
    expectTypeOf(mapDbError).returns.toEqualTypeOf<MappedDbError | null>()
    expectTypeOf<MappedDbError["_tag"]>().toEqualTypeOf<
      "Conflict" | "ForeignKeyViolation" | "NotNullViolation" | "NotFound" | "DbUnavailable"
    >()
  })
})

describe("fixed vocabulary (ADR-0005)", () => {
  it("db declares no NotFound / Conflict / DbUnavailable of its own", () => {
    expectTypeOf<typeof db>().not.toHaveProperty("NotFound")
    expectTypeOf<typeof db>().not.toHaveProperty("Conflict")
    expectTypeOf<typeof db>().not.toHaveProperty("DbUnavailable")
  })

  it("the fixed members of MappedDbError are exactly core's types", () => {
    expectTypeOf<Extract<MappedDbError, { _tag: "NotFound" }>>().toEqualTypeOf<NotFound>()
    expectTypeOf<Extract<MappedDbError, { _tag: "Conflict" }>>().toEqualTypeOf<Conflict>()
    expectTypeOf<Extract<MappedDbError, { _tag: "DbUnavailable" }>>().toEqualTypeOf<DbUnavailable>()
  })

  it("core's NotFound.is narrows db's error to optional props only (sound: no prop it lacks)", () => {
    const e = mapDbError(undefined)
    if (NotFound.is(e)) {
      expectTypeOf(e.resource).toEqualTypeOf<string | undefined>()
      expectTypeOf(e.id).toEqualTypeOf<string | undefined>()
      expectTypeOf(e).not.toHaveProperty("reason")
    }
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

  it("DbUnavailable carries no props: host, port and DSN stay on cause", () => {
    expectTypeOf<keyof DbUnavailable>().toEqualTypeOf<"_tag" | "message">()
  })
})
