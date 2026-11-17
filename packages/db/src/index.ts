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
 * (reach it for logging via core's `toThrowable(e).cause`).
 *
 * Every mapper returns the mapped tagged error, or `null` when the input is not a
 * recognized DB error — the caller decides (typically `orElseAsync` → map or rethrow as
 * defect). For a fuller Drizzle integration see `@unthrown/drizzle` (report pointer).
 */
import { type ErrorFactory, type TaggedError, taggedError } from "@friday-friday/core"

export const Conflict: ErrorFactory<"Conflict", { readonly field?: string; readonly constraint?: string }> =
  taggedError("Conflict")<{ readonly field?: string; readonly constraint?: string }>()
export type Conflict = ReturnType<typeof Conflict>

/** Where an integrity violation happened, as far as the driver says (schema names, never row values). */
export interface ConstraintLocation {
  readonly constraint?: string
  readonly column?: string
}

export const ForeignKeyViolation: ErrorFactory<"ForeignKeyViolation", ConstraintLocation> = taggedError(
  "ForeignKeyViolation"
)<ConstraintLocation>()
export type ForeignKeyViolation = ReturnType<typeof ForeignKeyViolation>

export const NotFound: ErrorFactory<"NotFound", { readonly reason?: string }> = taggedError("NotFound")<{
  readonly reason?: string
}>()
export type NotFound = ReturnType<typeof NotFound>

export const NotNullViolation: ErrorFactory<"NotNullViolation", ConstraintLocation> = taggedError(
  "NotNullViolation"
)<ConstraintLocation>()
export type NotNullViolation = ReturnType<typeof NotNullViolation>

export type MappedDbError = Conflict | ForeignKeyViolation | NotNullViolation | NotFound

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
 * Walk `e`, `e.cause`, `e.cause.cause`… and return the first node whose string `code` the
 * mapper recognises, with that code. The hop bound is also what makes it cycle-safe: a
 * self-referencing chain is visited at most `MAX_CAUSE_DEPTH + 1` times, then gives `null`.
 */
const findCoded = (e: unknown, known: ReadonlySet<string>): { readonly node: Probe; readonly code: string } | null => {
  let current: unknown = e
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    const node = asProbe(current)
    if (node === null) return null
    const code = node["code"]
    if (typeof code === "string" && known.has(code)) return { node, code }
    current = node["cause"]
  }
  return null
}

/** First own string-valued prop among `keys` (pg uses camel/flat names, postgres-js snake_case). */
const firstString = (o: Probe, ...keys: ReadonlyArray<string>): string | undefined => {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string") return v
  }
  return undefined
}

/** Constraint/column a PG driver attaches (pg: `constraint`/`column`; postgres-js: `*_name`). */
const pgLocationOf = (node: Probe): ConstraintLocation => {
  const constraint = firstString(node, "constraint", "constraint_name")
  const column = firstString(node, "column", "column_name")
  return { ...(constraint !== undefined ? { constraint } : {}), ...(column !== undefined ? { column } : {}) }
}

const PG_CODES: ReadonlySet<string> = new Set(["23505", "23503", "23502"])

/**
 * Map a PostgreSQL error by SQLSTATE: `23505` (unique_violation) → `Conflict`, `23503`
 * (foreign_key_violation) → `ForeignKeyViolation`, `23502` (not_null_violation) →
 * `NotNullViolation`, each with the constraint/column the driver names. Reads pg
 * (`DatabaseError`) and postgres-js (`PostgresError`) shapes, directly or wrapped on `cause`
 * (drizzle-orm's `DrizzleQueryError`). `U`: Neon's serverless driver is a pg fork and is
 * assumed to share pg's shape; not run. Returns `null` for anything else — callers rethrow
 * as defect.
 */
export function mapPgError(e: unknown): Conflict | ForeignKeyViolation | NotNullViolation | null {
  const found = findCoded(e, PG_CODES)
  if (found === null) return null
  const { node, code } = found
  const location = pgLocationOf(node)
  // A unique violation names its index, not a column: PG reports the key only in `detail`.
  if (code === "23505") {
    return Conflict({ ...(location.constraint !== undefined ? { constraint: location.constraint } : {}), cause: e })
  }
  if (code === "23503") return ForeignKeyViolation({ ...location, cause: e })
  return NotNullViolation({ ...location, cause: e })
}

const firstOf = (u: unknown): string | undefined => Array.isArray(u) && typeof u[0] === "string" ? u[0] : undefined

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
  if (meta === null) return {}
  const target = meta["target"]
  const adapter = asProbe(asProbe(asProbe(meta["driverAdapterError"])?.["cause"])?.["constraint"])
  const constraint = typeof target === "string"
    ? target
    : (firstString(meta, "constraint") ?? (adapter !== null ? firstString(adapter, "index") : undefined))
  const field = firstOf(target) ?? firstOf(adapter?.["fields"])
  return { ...(constraint !== undefined ? { constraint } : {}), ...(field !== undefined ? { field } : {}) }
}

const PRISMA_CODES: ReadonlySet<string> = new Set(["P2002", "P2003", "P2025"])

/**
 * Map a Prisma `PrismaClientKnownRequestError` by P-code: `P2002` (unique) → `Conflict`
 * (field and/or constraint), `P2003` (foreign key) → `ForeignKeyViolation`, `P2025`
 * (record not found) → `NotFound`. Codes and `meta` verified against Prisma 6.19 (Rust
 * engine) and 7.10 (`@prisma/adapter-pg`) on PostgreSQL 16. Returns `null` otherwise.
 */
export function mapPrismaError(e: unknown): Conflict | ForeignKeyViolation | NotFound | null {
  const found = findCoded(e, PRISMA_CODES)
  if (found === null) return null
  const { node, code } = found
  if (code === "P2002") return Conflict({ ...prismaLocationOf(node), cause: e })
  if (code === "P2003") {
    const { constraint, field } = prismaLocationOf(node)
    return ForeignKeyViolation({
      ...(constraint !== undefined ? { constraint } : {}),
      ...(field !== undefined ? { column: field } : {}),
      cause: e
    })
  }
  return NotFound({ reason: "record not found", cause: e })
}

/** Convenience: try Prisma then PG — projects can carry both code shapes in one codebase. */
export function mapDbError(e: unknown): MappedDbError | null {
  return mapPrismaError(e) ?? mapPgError(e)
}

export type { TaggedError }
