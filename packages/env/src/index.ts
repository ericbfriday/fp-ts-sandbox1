/**
 * `@friday-friday/env` — environment parsing (Design Report §5.9).
 *
 * `parseEnv(schema, env?)` validates an env record (`process.env` by default, or any record
 * you pass: `import.meta.env` for Vite/Workers, a test fixture) and returns a
 * `Result<T, ValidationFailure>`. Behind that one function it absorbs the env traps:
 *
 * - **Issues carry no vendor text.** Vendors echo the received value (`... but received
 *   "sk_live_…"`), and a transform in the pipe (`trim`, `toUpperCase`, `parseJson`) makes them
 *   echo a *derived* copy that no value match can catch. So `parseEnv` drops the vendor's
 *   issues and reports, once per vendor issue, `{ path: [NAME], message: "NAME is missing" }`
 *   (unset) or `"NAME is invalid"` (set); a root-level issue (path `[]`, e.g. an object-level
 *   `refine`) reads `"env is invalid"`. The path stops at the variable name, because segments
 *   below it can be data (a `record` key inside a JSON-valued variable). Nothing in a failure
 *   comes from a value, so it is safe to log or stringify. Trade-off: the vendor's *why*
 *   (`expected >=1024`, a custom `refine` message) is lost; to see it, run the schema through
 *   `parse` from `@friday-friday/schema` locally, and give cross-field checks a field path
 *   (Zod `refine(..., { path: ["B"] })`) so the failure names a variable. Redacting normalised
 *   copies of each value (#49 matched only the raw one) was rejected: transforms are open-ended
 *   (base64, split, slice), so no list of forms is complete, and each form costs bytes.
 * - **The default source never throws.** Without a global `process` (edge runtimes,
 *   browsers) the default env is `{}`, never a `TypeError`.
 * - **Blank is unset.** Values that are `""` or whitespace only are dropped before validation,
 *   so `FOO=` and `FOO=" "` behave like a missing `FOO`: `.optional()` gives `undefined`,
 *   `.default(x)` gives `x`, and `z.coerce.number()` can no longer turn `""` or `" "` into `0`.
 *   Other values are passed through untrimmed. For a variable that may legitimately be blank,
 *   use `.default("")` (or `.default(" ")`).
 *
 * Every value arrives as a `string`, so schemas coerce numbers themselves
 * (`z.coerce.number()`). **Never coerce booleans** (`z.coerce.boolean()` is JS truthiness:
 * `"false"` becomes `true`). Parse them strictly instead:
 * ```ts
 * DEBUG: z.stringbool().default(false)  // Zod 4: "true"/"1"/"yes"/"on" → true, "false"/"0"/"no"/"off" → false, else an issue
 * DEBUG: v.optional(v.pipe(v.picklist(["true", "false", "1", "0"]), v.transform((s) => s === "true" || s === "1")), "false")  // Valibot
 * ```
 *
 * **@t3-oss/env interop** (report: interop, don't compete): t3-env owns the *shape
 * definition* UX (client/server splitting, per-environment schema selection). Use
 * `parseEnv` inside a t3-env validator lambda when you want Result field errors instead
 * of t3-env's throw-on-first-error:
 * ```ts
 * server: { DATABASE_URL: z.string().url() },
 * validation: (env) => {
 *   const r = parseEnv(EnvSchema, env)
 *   if (!r.ok) throw new Error(JSON.stringify(r.error.issues))  // names and "missing"/"invalid" only
 * }
 * ```
 * For everything else, `parseEnv(schema)` at module load is the whole story: the Result is
 * plain data, so failures can be surfaced, logged, or defaulted without a throw at import
 * time.
 */
import { err, type Result } from "@friday-friday/core"
import { parse, type StandardSchemaV1, ValidationFailure } from "@friday-friday/schema"

/** Any string-keyed env-like record (`process.env`, `import.meta.env`, a test fixture). */
export type EnvLike = Readonly<Record<string, string | undefined>>

/**
 * A message built only from the variable name and whether it was set: never from vendor text,
 * which can echo the value or a derived copy of it (trimmed, case-changed, parsed).
 */
const genericIssue = (
  path: ReadonlyArray<string | number>,
  env: EnvLike
): { message: string; path: ReadonlyArray<string | number> } => {
  const name = path[0]
  if (name === undefined) return { message: "env is invalid", path: [] }
  return { message: `${name} is ${env[name] === undefined ? "missing" : "invalid"}`, path: [name] }
}

/** A copy of `env` without blank values (`""` or whitespace only), so `FOO= ` reads as unset. */
const withoutBlanks = (env: EnvLike): EnvLike =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value !== "string" || value.trim() !== ""))

/**
 * Validate the environment with a Standard Schema. Values arrive as `string` (blank values are
 * dropped as unset); coerce numbers in the schema and parse booleans strictly (see the module
 * doc). Each issue names only its variable and whether it was missing or invalid, never vendor
 * text, so no part of a value can reach a failure. The default `env` is `process.env` where it
 * exists and `{}` elsewhere.
 */
export function parseEnv<S extends StandardSchemaV1>(
  schema: S,
  env?: EnvLike
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> {
  const source = withoutBlanks(envRecord(env))
  const result = parse(schema, source)
  if (result.ok) return result
  return err(ValidationFailure({ issues: result.error.issues.map((issue) => genericIssue(issue.path, source)) }))
}

/** The provided record, else the live `process.env`, else `{}` (no `process` global). */
export function envRecord(overrides?: EnvLike): EnvLike {
  if (overrides !== undefined) return overrides
  // Node-only default; edge runtimes pass `import.meta.env` explicitly.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env !== undefined ? proc.env : {}
}
