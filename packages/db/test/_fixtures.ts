/**
 * Real-shaped driver/ORM errors for the `@friday-friday/db` mapper tests.
 *
 * Every field below was captured (2026-11-17) by provoking the violation against a local
 * PostgreSQL 16.15 and dumping the thrown error's own properties. The package stays
 * vendor-free, so the shapes are rebuilt here as plain classes with the same own props:
 *
 * - `pg` 8.23.1 (`DatabaseError` from pg-protocol 1.16.1): `code`, `constraint`, `column`,
 *   `table`, `detail` (row values!) as own props.
 * - `postgres` (postgres-js) 4.1.1 (`PostgresError`): same SQLSTATE `code`, but snake_case
 *   `constraint_name` / `column_name` / `table_name`, plus `query` / `parameters`.
 * - `drizzle-orm` 0.45.4 (`DrizzleQueryError`, node-postgres and postgres-js sessions): no
 *   `code` of its own; the driver error sits on `cause`, and the message embeds the query
 *   and its params. Verified by running, so the old "0.44+ wraps on cause" U is resolved.
 * - Prisma 6.19.3 (Rust query engine, `PrismaClientKnownRequestError`): P2002 carries
 *   `meta.target` (field names), P2003 `meta.constraint`.
 * - Prisma 7.10.1 + `@prisma/adapter-pg` 7.10.1 (driver adapters): P2002/P2003 carry no
 *   `target`; the constraint is at `meta.driverAdapterError.cause.constraint`, which is
 *   `{ index }` when PG names the constraint (captured) or `{ fields }` otherwise (read
 *   from adapter-pg's `convertDriverError` source, not provoked).
 */

/** Rebuilt pg-protocol `DatabaseError`: `name` is the protocol message name ("error"). */
class DatabaseError extends Error {
  constructor(message: string, fields: Record<string, string>) {
    super(message)
    this.name = "error"
    Object.assign(this, { severity: "ERROR", ...fields })
  }
}

/** Rebuilt postgres-js `PostgresError`. */
class PostgresError extends Error {
  constructor(message: string, fields: Record<string, unknown>) {
    super(message)
    this.name = "PostgresError"
    Object.assign(this, { severity_local: "ERROR", severity: "ERROR", ...fields })
  }
}

/** Rebuilt drizzle-orm `DrizzleQueryError`: the driver error is the `cause`. */
class DrizzleQueryError extends Error {
  readonly query: string
  readonly params: ReadonlyArray<unknown>
  constructor(query: string, params: ReadonlyArray<unknown>, cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause })
    this.query = query
    this.params = params
  }
}

/** Rebuilt Prisma `PrismaClientKnownRequestError`. */
class PrismaClientKnownRequestError extends Error {
  readonly code: string
  readonly meta: Record<string, unknown>
  readonly clientVersion: string
  constructor(message: string, opts: { code: string; meta: Record<string, unknown>; clientVersion: string }) {
    super(message)
    this.name = "PrismaClientKnownRequestError"
    this.code = opts.code
    this.meta = opts.meta
    this.clientVersion = opts.clientVersion
  }
}

// --- pg (node-postgres) ---------------------------------------------------------------

export const pgUnique = (): Error =>
  new DatabaseError("duplicate key value violates unique constraint \"users_email_key\"", {
    code: "23505",
    detail: "Key (email)=(a@example.com) already exists.",
    schema: "public",
    table: "users",
    constraint: "users_email_key",
    file: "nbtinsert.c",
    line: "666",
    routine: "_bt_check_unique"
  })

export const pgForeignKey = (): Error =>
  new DatabaseError("insert or update on table \"posts\" violates foreign key constraint \"posts_user_id_fkey\"", {
    code: "23503",
    detail: "Key (user_id)=(42) is not present in table \"users\".",
    schema: "public",
    table: "posts",
    constraint: "posts_user_id_fkey",
    file: "ri_triggers.c",
    line: "2608",
    routine: "ri_ReportViolation"
  })

export const pgNotNull = (): Error =>
  new DatabaseError("null value in column \"title\" of relation \"posts\" violates not-null constraint", {
    code: "23502",
    detail: "Failing row contains (2, 1, null).",
    schema: "public",
    table: "posts",
    column: "title",
    file: "execMain.c",
    line: "2057",
    routine: "ExecConstraints"
  })

export const pgUndefinedTable = (): Error =>
  new DatabaseError("relation \"nope\" does not exist", {
    code: "42P01",
    position: "15",
    file: "parse_relation.c",
    line: "1449",
    routine: "parserOpenTable"
  })

// --- postgres-js ----------------------------------------------------------------------

export const postgresJsUnique = (): Error =>
  new PostgresError("duplicate key value violates unique constraint \"users_email_key\"", {
    code: "23505",
    detail: "Key (email)=(a@example.com) already exists.",
    schema_name: "public",
    table_name: "users",
    constraint_name: "users_email_key",
    file: "nbtinsert.c",
    line: "666",
    routine: "_bt_check_unique",
    query: "insert into users values ($1, $2)",
    parameters: [2, "a@example.com"]
  })

export const postgresJsForeignKey = (): Error =>
  new PostgresError("insert or update on table \"posts\" violates foreign key constraint \"posts_user_id_fkey\"", {
    code: "23503",
    detail: "Key (user_id)=(42) is not present in table \"users\".",
    schema_name: "public",
    table_name: "posts",
    constraint_name: "posts_user_id_fkey",
    file: "ri_triggers.c",
    line: "2608",
    routine: "ri_ReportViolation",
    query: "insert into posts values ($1, $2, $3)",
    parameters: [1, 42, "t"]
  })

export const postgresJsNotNull = (): Error =>
  new PostgresError("null value in column \"title\" of relation \"posts\" violates not-null constraint", {
    code: "23502",
    detail: "Failing row contains (2, 1, null).",
    schema_name: "public",
    table_name: "posts",
    column_name: "title",
    file: "execMain.c",
    line: "2057",
    routine: "ExecConstraints",
    query: "insert into posts (id, user_id) values ($1, $2)",
    parameters: [2, 1]
  })

// --- drizzle-orm (wraps the driver error on `cause`) ----------------------------------

export const drizzleWrapped = (driverError: Error, query: string, params: ReadonlyArray<unknown>): Error =>
  new DrizzleQueryError(query, params, driverError)

// --- Prisma 6 (Rust engine) -----------------------------------------------------------

export const prisma6Unique = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.users.create()` invocation:\n\n\nUnique constraint failed on the fields: (`email`)",
    { code: "P2002", meta: { modelName: "users", target: ["email"] }, clientVersion: "6.19.3" }
  )

export const prisma6ForeignKey = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.posts.create()` invocation:\n\n\nForeign key constraint violated on the constraint: `posts_user_id_fkey`",
    { code: "P2003", meta: { modelName: "posts", constraint: "posts_user_id_fkey" }, clientVersion: "6.19.3" }
  )

export const prisma6NotFound = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.users.update()` invocation:\n\n\nAn operation failed because it depends on one or more records that were required but not found. No record was found for an update.",
    {
      code: "P2025",
      meta: { modelName: "users", cause: "No record was found for an update." },
      clientVersion: "6.19.3"
    }
  )

// --- Prisma 7 (driver adapters, @prisma/adapter-pg) -----------------------------------

const driverAdapterError = (cause: Record<string, unknown>): Record<string, unknown> => ({
  name: "DriverAdapterError",
  cause
})

export const prisma7Unique = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.users.create()` invocation:\n\n\nUnique constraint failed on the constraint: `users_email_key`",
    {
      code: "P2002",
      meta: {
        driverAdapterError: driverAdapterError({
          originalCode: "23505",
          originalMessage: "duplicate key value violates unique constraint \"users_email_key\"",
          kind: "UniqueConstraintViolation",
          constraint: { index: "users_email_key" },
          table: "users"
        }),
        modelName: "users"
      },
      clientVersion: "7.10.1"
    }
  )

/** Not provoked: adapter-pg emits `{ fields }` when PG reports no constraint name (source read). */
export const prisma7UniqueByFields = (): Error =>
  new PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", {
    code: "P2002",
    meta: {
      driverAdapterError: driverAdapterError({
        originalCode: "23505",
        kind: "UniqueConstraintViolation",
        constraint: { fields: ["email"] }
      }),
      modelName: "users"
    },
    clientVersion: "7.10.1"
  })

export const prisma7ForeignKey = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.posts.create()` invocation:\n\n\nForeign key constraint violated on the constraint: `posts_user_id_fkey`",
    {
      code: "P2003",
      meta: {
        modelName: "posts",
        driverAdapterError: driverAdapterError({
          originalCode: "23503",
          originalMessage: "insert or update on table \"posts\" violates foreign key constraint \"posts_user_id_fkey\"",
          kind: "ForeignKeyConstraintViolation",
          constraint: { index: "posts_user_id_fkey" }
        })
      },
      clientVersion: "7.10.1"
    }
  )

export const prisma7NotFound = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.users.update()` invocation:\n\n\nAn operation failed because it depends on one or more records that were required but not found. No record was found for an update.",
    { code: "P2025", meta: { modelName: "users", operation: "an update" }, clientVersion: "7.10.1" }
  )
