/**
 * `@friday-friday/db` — DB error mappers (Design Report §5.9).
 *
 * Mappers read vendor error shapes STRUCTURALLY, without importing any vendor: a string
 * `code` (SQLSTATE for `mapPgError`, P-code for `mapPrismaError`) found on the error or up
 * to 5 hops down its `cause` chain, so ORM wrappers such as drizzle-orm's
 * `DrizzleQueryError` map too. Shapes were captured from pg 8.23, postgres-js 4.1,
 * drizzle-orm 0.45 and Prisma 6.19 / 7.10 against PostgreSQL 16 (see test/_fixtures.ts).
 *
 * Wire safety (IDEA §4.2, RFC-0001 §5.3): mapped errors carry only schema names
 * (`constraint`, `column`, `field`) as props. Driver `detail` (e.g. `Key (email)=(a@b.c)`),
 * messages and query params hold row values, so they are never copied to a prop: the
 * original thrown error rides on `cause`, which stays server-side and every sanitizer drops
 * (reach it for logging via the mapped error's own `cause`).
 *
 * Fixed vocabulary (ADR-0005): `Conflict`, `NotFound` and `DbUnavailable` are core's
 * factories, so core's `is()` guards narrow these errors soundly; only the integrity tags with
 * no core equivalent (`ForeignKeyViolation`, `NotNullViolation`) are declared here.
 *
 * Connection failures map to `DbUnavailable` with no props (#88, #99): host, port and DSN text
 * stay on `cause`, and core `/wire` sends the tag + 503 only (#87). Codes are read, not message
 * text; the one exception is Prisma 6's codeless lazy-connect error, read only on its own class.
 *
 * Every mapper returns the mapped tagged error, or `null` when the input is not a
 * recognized DB error — the caller decides (typically `orElseAsync` → map or rethrow as
 * defect). For a fuller Drizzle integration see `@unthrown/drizzle` (report pointer).
 */
import {
  Conflict,
  DbUnavailable,
  type ErrorFactory,
  NotFound,
  type TaggedError,
  taggedError
} from "@friday-friday/core"

/** Where an integrity violation happened, as far as the driver says (schema names, never row values). */
export interface ConstraintLocation {
  readonly constraint?: string
  readonly column?: string
}

export const ForeignKeyViolation: ErrorFactory<"ForeignKeyViolation", ConstraintLocation> = taggedError(
  "ForeignKeyViolation"
)<ConstraintLocation>()
export type ForeignKeyViolation = ReturnType<typeof ForeignKeyViolation>

export const NotNullViolation: ErrorFactory<"NotNullViolation", ConstraintLocation> = taggedError(
  "NotNullViolation"
)<ConstraintLocation>()
export type NotNullViolation = ReturnType<typeof NotNullViolation>

export type MappedDbError = Conflict | ForeignKeyViolation | NotNullViolation | NotFound | DbUnavailable

/** An object-like node of an error chain, probed structurally (vendor classes never imported). */
type Probe = Readonly<Record<string, unknown>>

const asProbe = (u: unknown): Probe | null =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- boundary probe: every prop is type-checked at use
  u !== null && typeof u === "object" ? (u as Probe) : null

/**
 * How far down `cause` the mappers look. ORMs wrap once (drizzle-orm's `DrizzleQueryError`
 * puts the driver error on `cause`); 5 matches the defensive depth the next adapter uses
 * for `unstable_rethrow` (IDEA §6) and leaves room for app-level re-wraps.
 */
const MAX_CAUSE_DEPTH = 5

/**
 * Look at `e`, then `e.cause`, `e.cause.cause`… and return the first node for which `pick` reads
 * a code the mapper recognises, with that code. The hop bound is also what makes it cycle-safe: a
 * self-referencing chain is visited at most `MAX_CAUSE_DEPTH + 1` times, then gives `null`.
 */
const findCoded = (
  e: unknown,
  pick: (node: Probe) => string | undefined,
  depth = 0
): readonly [node: Probe, code: string] | null => {
  const node = asProbe(e)
  if (node === null || depth > MAX_CAUSE_DEPTH) return null
  const code = pick(node)
  return code !== undefined ? [node, code] : findCoded(node["cause"], pick, depth + 1)
}

/** The first of `values` that is a string `pattern` matches (any string by default). */
const firstString = (values: ReadonlyArray<unknown>, pattern: RegExp = /^/): string | undefined =>
  values.find((v): v is string => typeof v === "string" && pattern.test(v))

/**
 * `props` without its `undefined` values: an unnamed constraint is absent, not `undefined`. Every
 * value is a string or `undefined`, so a JSON round trip keeps the strings exactly and drops the rest.
 */
const defined = <P extends Readonly<Record<string, string | undefined>>>(
  props: P
): { readonly [K in keyof P]?: Exclude<P[K], undefined> } =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- see above: only the undefined values go
  JSON.parse(JSON.stringify(props)) as { readonly [K in keyof P]?: Exclude<P[K], undefined> }

/**
 * The codes `mapPgError` reads from `code`. SQLSTATE `2350x` are the integrity violations; every
 * other match means "the database can't be reached" and gives `DbUnavailable` (#88, #99):
 * - SQLSTATE class 08 (connection_exception) except `08P01` protocol_violation, which PG sends
 *   for client bugs such as a Bind with the wrong parameter count (captured): retrying can't help,
 *   so it stays a defect. `U`: the other class-08 codes were not provoked (libpq and proxies
 *   raise them; pg and postgres-js surface socket codes instead).
 * - `57P01` admin_shutdown, `57P02` crash_shutdown, `57P03` cannot_connect_now.
 * - Node socket codes `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`: pg and postgres-js
 *   throw the socket error itself (all captured). `EPIPE` and the like are not read.
 * - postgres-js's own `CONNECT_TIMEOUT` and `CONNECTION_CLOSED` (captured). `CONNECTION_ENDED` /
 *   `CONNECTION_DESTROYED` mean the app already called `sql.end()`, a client bug: not read.
 */
const PG_CODE =
  /^(2350[235]|08\d{3}|57P0[1-3]|E(CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT)|CONNECT(ION_CLOSED|_TIMEOUT))$/

/**
 * Map a PostgreSQL error by SQLSTATE: `23505` (unique_violation) → `Conflict`, `23503`
 * (foreign_key_violation) → `ForeignKeyViolation`, `23502` (not_null_violation) →
 * `NotNullViolation`, each with the constraint/column the driver names; connection failures
 * (class 08 but `08P01`, `57P01`–`57P03`, Node socket and postgres-js connection codes, see
 * `PG_CODE`) → core's `DbUnavailable`. Reads pg (`DatabaseError`) and postgres-js
 * (`PostgresError`) shapes and Node socket errors, directly or wrapped on `cause` (drizzle-orm's
 * `DrizzleQueryError`). Deliberately not read (#99): pg's codeless errors ("Connection terminated
 * unexpectedly", "timeout expired"), which pg throws as a bare `Error` with nothing but the
 * message, so they are indistinguishable from an app's `new Error` with the same text. `U`:
 * Neon's serverless driver is a pg fork and is assumed to share pg's shape; not run. Returns
 * `null` for anything else — callers rethrow as defect.
 */
export function mapPgError(e: unknown): Conflict | ForeignKeyViolation | NotNullViolation | DbUnavailable | null {
  const found = findCoded(e, (node) => firstString([node["code"]], PG_CODE))
  if (found === null) return null
  const [node, code] = found
  if (!code.startsWith("23")) return DbUnavailable({ cause: e })
  // pg names the constraint/column `constraint`/`column`, postgres-js `constraint_name`/`column_name`.
  const constraint = firstString([node["constraint"], node["constraint_name"]])
  // A unique violation names its index, not a column: PG reports the key only in `detail`.
  if (code === "23505") return Conflict({ ...defined({ constraint }), cause: e })
  const location = defined({ constraint, column: firstString([node["column"], node["column_name"]]) })
  return (code === "23503" ? ForeignKeyViolation : NotNullViolation)({ ...location, cause: e })
}

/** `u[0]` when `u` is an array whose first item is a string. */
const firstOf = (u: unknown): string | undefined => firstString([Array.isArray(u) && u[0]])

/**
 * Where Prisma says a constraint failed. Two generations of shape (both captured, see
 * test/_fixtures.ts):
 * - Rust engine (Prisma <= 6): `meta.target` = field names (P2002), `meta.constraint` (P2003).
 *   `U`: `meta.target` as a plain index-name string (other connectors) is from Prisma's
 *   error reference, not provoked here; it is read as the constraint name.
 * - Driver adapters (Prisma 7): `meta.driverAdapterError.cause.constraint` is `{ index }`
 *   or `{ fields }`.
 */
const prismaLocationOf = (node: Probe): { readonly constraint?: string; readonly field?: string } => {
  const meta = asProbe(node["meta"])
  const target = meta?.["target"]
  const adapter = asProbe(asProbe(asProbe(meta?.["driverAdapterError"])?.["cause"])?.["constraint"])
  return defined({
    constraint: firstString([target, meta?.["constraint"], adapter?.["index"]]),
    field: firstOf(target) ?? firstOf(adapter?.["fields"])
  })
}

/** The P-codes `mapPrismaError` reads; every `P1xxx` here is a connection failure. */
const PRISMA_CODE = /^P(10(0[128]|17)|20(0[23]|10|25|39))$/

/**
 * The P-code on a Prisma error node: `code` (`PrismaClientKnownRequestError`) or `errorCode`
 * (`PrismaClientInitializationError`). Prisma 6 leaves `errorCode` undefined when the first query
 * connects lazily (captured), so for that one class, and only it, the "Can't reach database
 * server" text Prisma writes for P1001 is read as P1001 (#99): the same text on any other error
 * is not read.
 */
const prismaCode = (node: Probe): string | undefined =>
  firstString([node["code"], node["errorCode"]], PRISMA_CODE)
    ?? (node["name"] === "PrismaClientInitializationError"
        && firstString([node["message"]], /Can't reach database server/)
      ? "P1001"
      : undefined)

/**
 * Map a Prisma error by P-code: `P2002` (unique) → `Conflict` (field and/or constraint),
 * `P2003` (foreign key) → `ForeignKeyViolation`, `P2025` (record not found) → `NotFound`, and
 * connection failures → `DbUnavailable`: `P1001` (can't reach server, including Prisma 6's lazy
 * connect, see `prismaCode`), `P1002` (reached, timed out), `P1008` (operation timed out),
 * `P1017` (server closed the connection), and `P2010` (raw query) / `P2039` (Prisma 7 model query)
 * when the SQLSTATE they wrap is one `mapPgError` reads as a connection failure (`meta.code` on
 * Prisma 6, `meta.driverAdapterError.cause.code` on Prisma 7). Verified against Prisma 6.19 (Rust
 * engine) and 7.10 (`@prisma/adapter-pg`) on PostgreSQL 16, except P1002 (`U`, not provoked).
 * Deliberately not read (#99): a Prisma 6 model query cut off by 57P01 throws
 * `PrismaClientUnknownRequestError` with no code, the SQLSTATE only inside Rust debug text.
 * Returns `null` otherwise.
 */
export function mapPrismaError(e: unknown): Conflict | ForeignKeyViolation | NotFound | DbUnavailable | null {
  const found = findCoded(e, prismaCode)
  if (found === null) return null
  const [node, code] = found
  if (code.startsWith("P1")) return DbUnavailable({ cause: e })
  if (code === "P2002") return Conflict({ ...prismaLocationOf(node), cause: e })
  if (code === "P2003") {
    const { constraint, field } = prismaLocationOf(node)
    return ForeignKeyViolation({ ...defined({ constraint, column: field }), cause: e })
  }
  if (code === "P2025") return NotFound({ cause: e })
  // P2010 / P2039: a 503 only when the wrapped SQLSTATE is a connection failure (#99).
  const meta = asProbe(node["meta"])
  return DbUnavailable.is(mapPgError(meta?.["driverAdapterError"] ?? meta)) ? DbUnavailable({ cause: e }) : null
}

/** Convenience: try Prisma then PG — projects can carry both code shapes in one codebase. */
export const mapDbError = (e: unknown): MappedDbError | null => mapPrismaError(e) ?? mapPgError(e)

export type { TaggedError }
