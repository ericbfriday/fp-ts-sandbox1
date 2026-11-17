/**
 * `@friday-friday/db` runtime tests, through the package's public interface. Inputs are
 * the real error shapes thrown by pg, postgres-js, drizzle-orm and Prisma 6/7, captured
 * against a live PostgreSQL and rebuilt vendor-free in `_fixtures.ts`.
 */
import {
  Conflict,
  ForeignKeyViolation,
  mapDbError,
  mapPgError,
  mapPrismaError,
  NotFound,
  NotNullViolation
} from "@friday-friday/db"
import { describe, expect, it } from "vitest"
import {
  drizzleWrapped,
  pgForeignKey,
  pgNotNull,
  pgUndefinedTable,
  pgUnique,
  postgresJsForeignKey,
  postgresJsNotNull,
  postgresJsUnique,
  prisma6ForeignKey,
  prisma6NotFound,
  prisma6Unique,
  prisma7ForeignKey,
  prisma7NotFound,
  prisma7Unique,
  prisma7UniqueByFields
} from "./_fixtures.js"

/**
 * What survives a boundary: every sanitizer drops `cause` (RFC-0001 §5.3) and keeps the
 * JSON-safe props, so this is the strictest view a client can get of a mapped error.
 */
const wireJson = (e: object | null): string => JSON.stringify({ ...e, cause: undefined })

describe("driver detail and row values stay server-side", () => {
  // Every real-shaped input that maps, including ORM wrappers whose message embeds params.
  const inputs: ReadonlyArray<readonly [string, () => Error]> = [
    ["pg 23505", pgUnique],
    ["pg 23503", pgForeignKey],
    ["pg 23502", pgNotNull],
    ["postgres-js 23505", postgresJsUnique],
    ["postgres-js 23503", postgresJsForeignKey],
    ["postgres-js 23502", postgresJsNotNull],
    ["drizzle(pg 23505)", () => drizzleWrapped(pgUnique(), "insert into users values ($1, $2)", [2, "a@example.com"])],
    ["drizzle(pg 23503)", () => drizzleWrapped(pgForeignKey(), "insert into posts values ($1, $2, $3)", [1, 42, "t"])],
    ["prisma 6 P2002", prisma6Unique],
    ["prisma 6 P2003", prisma6ForeignKey],
    ["prisma 6 P2025", prisma6NotFound],
    ["prisma 7 P2002", prisma7Unique],
    ["prisma 7 P2003", prisma7ForeignKey],
    ["prisma 7 P2025", prisma7NotFound]
  ]

  it.each(inputs)("%s: no detail/message/query text outside cause; original reachable on cause", (_, make) => {
    const e = make()
    const mapped = mapDbError(e)
    expect(mapped).not.toBe(null)
    expect(mapped).toHaveProperty("cause", e)
    const wire = wireJson(mapped)
    for (const leak of ["a@example.com", "(42)", "Failing row", "Key (", "insert into", "Invalid `prisma"]) {
      expect(wire).not.toContain(leak)
    }
    expect(mapped).not.toHaveProperty("detail")
    expect(mapped).not.toHaveProperty("message")
  })
})

describe("mapPgError (SQLSTATE)", () => {
  it("pg 23505 -> Conflict carrying the constraint name, driver error kept on cause", () => {
    const e = pgUnique()
    expect(mapPgError(e)).toEqual(Conflict({ constraint: "users_email_key", cause: e }))
  })

  it("postgres-js 23505 -> Conflict reading snake_case constraint_name", () => {
    const e = postgresJsUnique()
    expect(mapPgError(e)).toEqual(Conflict({ constraint: "users_email_key", cause: e }))
  })

  it("pg 23503 -> ForeignKeyViolation with the constraint; detail (row values) stays on cause", () => {
    const e = pgForeignKey()
    const mapped = mapPgError(e)
    expect(mapped).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: e }))
    expect(mapped).not.toHaveProperty("detail")
  })

  it("23502 -> NotNullViolation with the column (pg column / postgres-js column_name); failing row stays on cause", () => {
    const pg = pgNotNull()
    expect(mapPgError(pg)).toEqual(NotNullViolation({ column: "title", cause: pg }))
    const pgJs = postgresJsNotNull()
    expect(mapPgError(pgJs)).toEqual(NotNullViolation({ column: "title", cause: pgJs }))
  })

  it("other codes / non-errors -> null (caller rethrows as defect)", () => {
    expect(mapPgError(pgUndefinedTable())).toBe(null)
    expect(mapPgError(new Error("boom"))).toBe(null)
    expect(mapPgError(null)).toBe(null)
    expect(mapPgError(undefined)).toBe(null)
  })
})

describe("cause chain (drizzle-orm wraps the driver error in DrizzleQueryError)", () => {
  it("finds the SQLSTATE on cause for node-postgres and postgres-js sessions", () => {
    const viaPg = drizzleWrapped(pgUnique(), "insert into users values ($1, $2)", [2, "a@example.com"])
    expect(mapPgError(viaPg)).toEqual(Conflict({ constraint: "users_email_key", cause: viaPg }))
    const viaPgJs = drizzleWrapped(postgresJsForeignKey(), "insert into posts values ($1, $2, $3)", [1, 42, "t"])
    expect(mapPgError(viaPgJs)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: viaPgJs }))
  })

  it("is depth-limited: a driver code 5 wraps down maps, 6 wraps down does not", () => {
    const wrap = (inner: unknown, times: number): unknown =>
      times === 0 ? inner : wrap(new Error("wrapped", { cause: inner }), times - 1)
    const five = wrap(pgUnique(), 5)
    expect(mapPgError(five)).toEqual(Conflict({ constraint: "users_email_key", cause: five }))
    expect(mapPgError(wrap(pgUnique(), 6))).toBe(null)
  })

  it("is cycle-safe: a self-referencing cause chain returns null instead of looping", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    Object.assign(a, { cause: b })
    expect(mapPgError(a)).toBe(null)
    expect(mapPrismaError(a)).toBe(null)
  })
})

describe("mapPrismaError (P-codes)", () => {
  it("Prisma 6 P2002 -> Conflict with the field from meta.target", () => {
    const e = prisma6Unique()
    expect(mapPrismaError(e)).toEqual(Conflict({ field: "email", cause: e }))
  })

  it("Prisma 7 (driver adapter) P2002 -> Conflict from meta.driverAdapterError.cause.constraint", () => {
    const byIndex = prisma7Unique()
    expect(mapPrismaError(byIndex)).toEqual(Conflict({ constraint: "users_email_key", cause: byIndex }))
    const byFields = prisma7UniqueByFields()
    expect(mapPrismaError(byFields)).toEqual(Conflict({ field: "email", cause: byFields }))
  })

  it("P2003 (Prisma 6 meta.constraint / Prisma 7 adapter index) -> ForeignKeyViolation", () => {
    const v6 = prisma6ForeignKey()
    expect(mapPrismaError(v6)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: v6 }))
    const v7 = prisma7ForeignKey()
    expect(mapPrismaError(v7)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: v7 }))
  })

  it("P2025 -> NotFound (Prisma 6 and 7), original kept on cause", () => {
    for (const e of [prisma6NotFound(), prisma7NotFound()]) {
      expect(mapPrismaError(e)).toEqual(NotFound({ reason: "record not found", cause: e }))
    }
  })

  it("unknown P-codes and SQLSTATEs -> null", () => {
    expect(mapPrismaError({ code: "P9999" })).toBe(null)
    expect(mapPrismaError(pgUnique())).toBe(null)
  })
})

describe("mapDbError (both vocabularies)", () => {
  it("tries Prisma then PG, through wrappers too", () => {
    const prisma = prisma6Unique()
    expect(mapDbError(prisma)).toEqual(Conflict({ field: "email", cause: prisma }))
    const fk = pgForeignKey()
    expect(mapDbError(fk)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: fk }))
    const wrapped = drizzleWrapped(pgNotNull(), "insert into posts (id, user_id) values ($1, $2)", [2, 1])
    expect(mapDbError(wrapped)).toEqual(NotNullViolation({ column: "title", cause: wrapped }))
    expect(mapDbError(pgUndefinedTable())).toBe(null)
  })
})
