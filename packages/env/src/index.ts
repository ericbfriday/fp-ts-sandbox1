/**
 * `@friday-friday/env` — environment parsing (Design Report §5.9).
 *
 * `parseEnv` is `parse` over `process.env` (or any record you pass — `import.meta.env` for
 * Vite/Workers, or a test fixture). Every value is `string | undefined`, so schemas should
 * coerce (`z.coerce.number()`) and mark optionality themselves.
 *
 * **@t3-oss/env interop** (report: interop, don't compete): t3-env owns the *shape
 * definition* UX (client/server splitting, per-environment schema selection). Use
 * `parseEnv` inside a t3-env validator lambda when you want Result/fl field errors instead
 * of t3-env's throw-on-first-error:
 * ```ts
 * server: { DATABASE_URL: z.string().url() },
 * validation: (env) => {
 *   const r = parseEnv(EnvSchema, env)
 *   if (!r.ok) throw new Error(JSON.stringify(r.error.issues))  // or handle as data
 * }
 * ```
 * For everything else, `parseEnv(schema)` at module load is the whole story: the Result is
 * plain data, so failures can be surfaced, logged, or defaulted without a throw at import
 * time.
 */
import { err, ok, type Result } from "@friday-friday/core"
import { parse, type StandardSchemaV1, type ValidationFailure } from "@friday-friday/schema"

/** Any string-keyed env-like record (`process.env`, `import.meta.env`, a test fixture). */
export type EnvLike = Readonly<Record<string, string | undefined>>

/**
 * Validate the environment with a Standard Schema. All values arrive as `string |
 * undefined` — coerce in the schema (`z.coerce.number()`), never here.
 */
export function parseEnv<S extends StandardSchemaV1>(
  schema: S,
  env: EnvLike = process.env
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> {
  return parse(schema, env)
}

/** The live env (`process.env`) or the provided record, as a frozen plain record. */
export function envRecord(overrides?: EnvLike): EnvLike {
  if (overrides !== undefined) return overrides
  // Node-only default; edge runtimes pass `import.meta.env` explicitly.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env !== undefined ? proc.env : {}
}

export { err, ok }
