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
 *
 * Connection failures (#88), captured 2026-11-19 on Node 24.22 against the same PostgreSQL
 * 16.15, from the same driver versions plus `@prisma/adapter-pg` 7.10.1 and a generated
 * Prisma 6.19.3 client:
 * - Node `net`: a refused connect is a plain `Error` with own `errno`, `code`, `syscall`,
 *   `address`, `port` (in that order); a failed DNS lookup has `hostname` instead of
 *   `address`/`port`. pg and drizzle-orm throw it as is (drizzle on `cause`); postgres-js
 *   throws the same object with its own `query`/`parameters`/`args`/`types` added.
 * - 57P01 (`pg_terminate_backend`, `pg_ctl -m fast stop`) and 57P03 (connecting during
 *   `pg_ctl -m smart stop`, or during crash recovery) arrive as FATAL ErrorResponses: pg
 *   `DatabaseError` / postgres-js `PostgresError`, same props as the integrity errors.
 * - Prisma 7 (adapter-pg): ECONNREFUSED and ENOTFOUND become `PrismaClientKnownRequestError`
 *   P1001, with the host and port only under `meta.driverAdapterError.cause`.
 * - Prisma 6 (Rust engine): an unreachable server is `PrismaClientInitializationError`;
 *   `errorCode` is "P1001" from `$connect()`, but `undefined` when the first query connects
 *   lazily (captured both).
 *
 * Shapes marked `U` below are hand-built from the vendor's docs or source and were not
 * provoked: Node's ETIMEDOUT, class-08 SQLSTATEs other than 08P01, 57P02 and Prisma P1002.
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

/** Rebuilt Prisma `PrismaClientInitializationError`: the P-code is `errorCode`, not `code`. */
class PrismaClientInitializationError extends Error {
  readonly clientVersion: string
  readonly errorCode: string | undefined
  constructor(message: string, clientVersion: string, errorCode: string | undefined) {
    super(message)
    this.name = "PrismaClientInitializationError"
    this.clientVersion = clientVersion
    this.errorCode = errorCode
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

// --- connection failures (#88) --------------------------------------------------------

/** Built the way Node's `net` builds a socket error: an `Error` plus own `errno`/`code`/`syscall`/... */
const socketError = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields)

/** Captured: `connect()` to a closed port (pg and drizzle throw this object unchanged). */
export const socketRefused = (): Error =>
  socketError("connect ECONNREFUSED 10.0.0.5:5432", {
    errno: -111,
    code: "ECONNREFUSED",
    syscall: "connect",
    address: "10.0.0.5",
    port: 5432
  })

/** Captured: DNS lookup of an unknown host. */
export const dnsNotFound = (): Error =>
  socketError("getaddrinfo ENOTFOUND db.internal.example", {
    errno: -3008,
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "db.internal.example"
  })

/** `U`: not provoked (needs dropped SYNs); errno -110 is Linux's ETIMEDOUT, layout as ECONNREFUSED. */
export const socketTimedOut = (): Error =>
  socketError("connect ETIMEDOUT 10.0.0.5:5432", {
    errno: -110,
    code: "ETIMEDOUT",
    syscall: "connect",
    address: "10.0.0.5",
    port: 5432
  })

/** Captured: postgres-js rethrows the socket error with the pending query attached. */
export const postgresJsRefused = (): Error =>
  Object.assign(socketRefused(), {
    query: "select * from users where email = $1",
    parameters: ["a@example.com"],
    args: [],
    types: []
  })

/** Captured: `pg_terminate_backend` / `pg_ctl -m fast stop` while a query runs (pg). */
export const pgAdminShutdown = (): Error =>
  new DatabaseError("terminating connection due to administrator command", {
    severity: "FATAL",
    code: "57P01",
    file: "postgres.c",
    line: "3328",
    routine: "ProcessInterrupts"
  })

/** Captured: the same 57P01 through postgres-js. */
export const postgresJsAdminShutdown = (): Error =>
  new PostgresError("terminating connection due to administrator command", {
    severity_local: "FATAL",
    severity: "FATAL",
    code: "57P01",
    file: "postgres.c",
    line: "3328",
    routine: "ProcessInterrupts",
    query: "select pg_sleep(5)",
    parameters: []
  })

/**
 * `U`: PG 16 sent 57P02 (another backend crashed) as a WARNING NoticeResponse in the capture:
 * pg threw "Connection terminated unexpectedly" (no code), postgres-js logged a notice and threw
 * CONNECTION_CLOSED. Rebuilt as the ErrorResponse a driver would throw if one arrived.
 */
export const pgCrashShutdown = (): Error =>
  new DatabaseError("terminating connection because of crash of another server process", {
    severity: "FATAL",
    code: "57P02",
    detail: "The postmaster has commanded this server process to roll back the current transaction and exit.",
    file: "postgres.c",
    line: "2962",
    routine: "quickdie"
  })

/** Captured: connecting while the server is in smart shutdown (pg). */
export const pgCannotConnectNow = (): Error =>
  new DatabaseError("the database system is shutting down", {
    severity: "FATAL",
    code: "57P03",
    file: "postmaster.c",
    line: "2375",
    routine: "ProcessStartupPacket"
  })

/** Captured: connecting during crash recovery (postgres-js shape of the same 57P03). */
export const postgresJsCannotConnectNow = (): Error =>
  new PostgresError("the database system is in recovery mode", {
    severity_local: "FATAL",
    severity: "FATAL",
    code: "57P03",
    file: "postmaster.c",
    line: "2380",
    routine: "ProcessStartupPacket"
  })

/** `U`: class 08 SQLSTATEs other than 08P01 were not provoked; message text from PG's errcodes.txt. */
export const pgConnectionException = (code: string): Error =>
  new DatabaseError(`connection exception ${code}`, { severity: "FATAL", code })

/** Captured: 08P01 from a Bind with the wrong parameter count, a client bug (stays unmapped). */
export const pgProtocolViolation = (): Error =>
  new DatabaseError("bind message supplies 2 parameters, but prepared statement \"\" requires 1", {
    code: "08P01",
    file: "postgres.c",
    line: "1731",
    routine: "exec_bind_message"
  })

/** Captured: Prisma 7 + adapter-pg, ECONNREFUSED on the first query. */
export const prisma7Unreachable = (): Error =>
  new PrismaClientKnownRequestError(
    "\nInvalid `prisma.users.findMany()` invocation:\n\n\nCan't reach database server at 10.0.0.5:5432",
    {
      code: "P1001",
      meta: {
        modelName: "users",
        driverAdapterError: {
          name: "DriverAdapterError",
          message: "DatabaseNotReachable",
          cause: { kind: "DatabaseNotReachable", host: "10.0.0.5", port: 5432 }
        }
      },
      clientVersion: "7.10.1"
    }
  )

/** Captured: Prisma 6 `$connect()` to an unreachable server. */
export const prisma6UnreachableOnConnect = (): Error =>
  new PrismaClientInitializationError(
    "Can't reach database server at `10.0.0.5:5432`\n\nPlease make sure your database server is running at `10.0.0.5:5432`.",
    "6.19.3",
    "P1001"
  )

/** Captured: Prisma 6 lazy connect on the first query, which leaves `errorCode` undefined. */
export const prisma6UnreachableOnQuery = (): Error =>
  new PrismaClientInitializationError(
    "\nInvalid `prisma.users.findMany()` invocation:\n\n\nCan't reach database server at `10.0.0.5:5432`\n\nPlease make sure your database server is running at `10.0.0.5:5432`.",
    "6.19.3",
    undefined
  )

/** `U`: P1002 not provoked (a silent server gave P1001); message from Prisma's error reference. */
export const prisma6ReachedButTimedOut = (): Error =>
  new PrismaClientInitializationError(
    "The database server at `10.0.0.5`:`5432` was reached but timed out. Please try again.",
    "6.19.3",
    "P1002"
  )
