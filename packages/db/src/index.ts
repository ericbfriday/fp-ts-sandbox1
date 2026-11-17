/**
 * `@friday-friday/db` — DB error mappers (Design Report §5.9).
 *
 * Mappers read vendor error shapes STRUCTURALLY (`code` fields), so they work for Drizzle
 * on `pg`/`postgres-js`/Neon (mapPgError — SQLSTATE codes) and Prisma (mapPrismaError —
 * P-codes from Prisma's long-standing error reference) without importing any vendor.
 *
 * Both mappers return the mapped tagged error, or `null` when the input is not a
 * recognized DB error — the caller decides (typically `orElseAsync` → map or rethrow as
 * defect). For a fuller Drizzle integration see `@unthrown/drizzle` (report pointer).
 *
 * These P-code mappings follow Prisma's long-standing error reference; they were NOT
 * re-verified against Prisma sources this pass (report caveat, kept as a `U` note).
 */
import { type ErrorFactory, type TaggedError, taggedError } from "@friday-friday/core"

export const Conflict: ErrorFactory<"Conflict", { readonly field?: string }> = taggedError("Conflict")<{
  readonly field?: string
}>()
export type Conflict = ReturnType<typeof Conflict>

export const ForeignKeyViolation: ErrorFactory<
  "ForeignKeyViolation",
  { readonly constraint?: string; readonly detail?: string }
> = taggedError("ForeignKeyViolation")<{ readonly constraint?: string; readonly detail?: string }>()
export type ForeignKeyViolation = ReturnType<typeof ForeignKeyViolation>

export const NotFound: ErrorFactory<"NotFound", { readonly reason?: string }> = taggedError("NotFound")<{
  readonly reason?: string
}>()
export type NotFound = ReturnType<typeof NotFound>

export type MappedDbError = Conflict | ForeignKeyViolation | NotFound

/** Structural probe: an object with a string `code` (vendor errors carry it top-level). */
const codeOf = (e: unknown): string | null => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- boundary probe: code verified as string below
  const candidate = e as { code?: unknown } | null
  if (candidate !== null && typeof candidate === "object" && typeof candidate.code === "string") {
    return candidate.code
  }
  return null
}

/** Optional extra properties commonly attached to PG/Prisma errors. */
const extrasOf = (e: unknown): { readonly constraint?: string; readonly detail?: string; readonly field?: string } => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- boundary probe: each field verified before use
  const c = e as { constraint?: unknown; detail?: unknown; column?: unknown; meta?: unknown } | null
  if (c === null || typeof c !== "object") return {}
  const meta = c.meta !== null && typeof c.meta === "object" ? (c.meta as { target?: unknown }) : undefined
  const field = Array.isArray(meta?.target) ? String(meta.target[0]) : undefined
  const constraint = typeof c.constraint === "string" ? c.constraint : undefined
  const detail = typeof c.detail === "string" ? c.detail : typeof c.column === "string" ? c.column : undefined
  return {
    ...(constraint !== undefined ? { constraint } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(field !== undefined ? { field } : {})
  }
}

/**
 * Map a PostgreSQL error (Drizzle on `pg`/`postgres-js`/Neon) by SQLSTATE code:
 * `23505` (unique_violation) → `Conflict`, `23503` (foreign_key_violation) →
 * `ForeignKeyViolation`. Returns `null` for anything else — callers rethrow as defect.
 */
export function mapPgError(e: unknown): Conflict | ForeignKeyViolation | null {
  const code = codeOf(e)
  if (code === "23505") {
    const { field } = extrasOf(e)
    return field !== undefined ? Conflict({ field }) : Conflict({})
  }
  if (code === "23503") {
    const { constraint, detail } = extrasOf(e)
    if (constraint !== undefined && detail !== undefined) {
      return ForeignKeyViolation({ constraint, detail })
    }
    if (constraint !== undefined) return ForeignKeyViolation({ constraint })
    if (detail !== undefined) return ForeignKeyViolation({ detail })
    return ForeignKeyViolation({})
  }
  return null
}

/**
 * Map a Prisma error by its P-code: `P2002` (unique constraint) → `Conflict` (with the
 * `meta.target` field), `P2025` (record not found) → `NotFound`. `U`: codes from Prisma's
 * error reference, not re-verified against Prisma sources this pass.
 */
export function mapPrismaError(e: unknown): Conflict | NotFound | null {
  const code = codeOf(e)
  if (code === "P2002") {
    const { field } = extrasOf(e)
    return field !== undefined ? Conflict({ field }) : Conflict({})
  }
  if (code === "P2025") {
    return NotFound({ reason: "record not found" })
  }
  return null
}

/** Convenience: try Prisma then PG — projects can carry both code shapes in one codebase. */
export function mapDbError(e: unknown): MappedDbError | null {
  return mapPrismaError(e) ?? mapPgError(e)
}

export type { TaggedError }
