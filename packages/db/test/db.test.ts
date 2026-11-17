/**
 * `@friday-friday/db` runtime tests. Vendor shapes are replicated structurally (plain
 * objects with `code`/`constraint`/`meta.target`) — no vendor imports, exactly the
 * contract the mappers rely on.
 */
import { Conflict, ForeignKeyViolation, mapDbError, mapPgError, mapPrismaError, NotFound } from "@friday-friday/db"
import { describe, expect, it } from "vitest"

describe("mapPgError (SQLSTATE)", () => {
  it("23505 -> Conflict with the field when meta.target carries it", () => {
    const e = { code: "23505", constraint: "users_email_key", detail: "Key (email) already exists." }
    expect(mapPgError(e)).toEqual(Conflict({}))
    const drizzle = { code: "23505", meta: { target: ["email"] } }
    expect(mapPgError(drizzle)).toEqual(Conflict({ field: "email" }))
  })

  it("23503 -> ForeignKeyViolation with constraint/detail", () => {
    const e = { code: "23503", constraint: "posts_user_id_fkey", detail: "Key (user_id) not present." }
    expect(mapPgError(e)).toEqual(
      ForeignKeyViolation({ constraint: "posts_user_id_fkey", detail: "Key (user_id) not present." })
    )
  })

  it("other codes / non-errors -> null (caller rethrows as defect)", () => {
    expect(mapPgError({ code: "42P01" })).toBe(null)
    expect(mapPgError(new Error("boom"))).toBe(null)
    expect(mapPgError(null)).toBe(null)
    expect(mapPgError(undefined)).toBe(null)
  })

  it("reads code structurally: pg, postgres-js and Neon shapes all map", () => {
    // pg: DatabaseError has .code; postgres-js/Neon wrap similarly — the probe is the same.
    class FakeDatabaseError extends Error {
      code = "23505"
    }
    expect(mapPgError(new FakeDatabaseError("duplicate key"))).toEqual(Conflict({}))
  })
})

describe("mapPrismaError (P-codes)", () => {
  it("P2002 -> Conflict with meta.target field", () => {
    const e = { code: "P2002", meta: { target: ["email"] } }
    expect(mapPrismaError(e)).toEqual(Conflict({ field: "email" }))
    expect(mapPrismaError({ code: "P2002" })).toEqual(Conflict({}))
  })

  it("P2025 -> NotFound", () => {
    expect(mapPrismaError({ code: "P2025" })).toEqual(NotFound({ reason: "record not found" }))
  })

  it("unknown P-codes -> null", () => {
    expect(mapPrismaError({ code: "P9999" })).toBe(null)
  })
})

describe("mapDbError (both vocabularies)", () => {
  it("tries Prisma then PG", () => {
    expect(mapDbError({ code: "P2002" })).toEqual(Conflict({}))
    expect(mapDbError({ code: "23503", constraint: "c" })).toEqual(ForeignKeyViolation({ constraint: "c" }))
    expect(mapDbError({ code: "whatever" })).toBe(null)
  })
})
