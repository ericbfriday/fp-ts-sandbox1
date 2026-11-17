/**
 * `@friday-friday/env` — environment parsing (Design Report §5.9).
 *
 * `parseEnv(schema, env?)` validates an env record (`process.env` by default, or any record
 * you pass: `import.meta.env` for Vite/Workers, a test fixture) and returns a
 * `Result<T, ValidationFailure>`. Behind that one function it absorbs the env traps:
 *
 * - **Secrets never reach issue messages.** Vendors such as Valibot and ArkType echo the
 *   received value (`... but received "sk_live_…"`). `parseEnv` replaces the value of the
 *   variable an issue is reported against with `[redacted]` (root-level issues, path `[]`,
 *   have every variable's value redacted), so a failure is safe to log or stringify.
 * - **The default source never throws.** Without a global `process` (edge runtimes,
 *   browsers) the default env is `{}`, never a `TypeError`.
 * - **`""` is unset.** Empty-string values are dropped before validation, so `FOO=` behaves
 *   like a missing `FOO`: `.optional()` gives `undefined`, `.default(x)` gives `x`, and
 *   `z.coerce.number()` can no longer turn `""` into `0`. For a variable that may
 *   legitimately be empty, use `.default("")`.
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
 * `parseEnv` inside a t3-env validator lambda when you want Result/fl field errors instead
 * of t3-env's throw-on-first-error:
 * ```ts
 * server: { DATABASE_URL: z.string().url() },
 * validation: (env) => {
 *   const r = parseEnv(EnvSchema, env)
 *   if (!r.ok) throw new Error(JSON.stringify(r.error.issues))  // messages are redacted
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

/** What replaces an env value inside an issue message. */
const REDACTED = "[redacted]"

/** A letter, digit or `_`: an occurrence touching one of these is part of a longer token. */
const WORD_CHAR = /[\p{L}\p{N}_]/u

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR.test(ch)

/**
 * Replace every standalone occurrence of `needle` in `text`. An occurrence glued to a letter,
 * digit or `_` is left alone, so redacting `"1"` keeps `>=1024` intact while still catching
 * `received 1` and `"1"`.
 */
const redactToken = (text: string, needle: string): string => {
  let out = ""
  let from = 0
  let at = text.indexOf(needle, from)
  while (at !== -1) {
    const end = at + needle.length
    if (!isWordChar(text[at - 1]) && !isWordChar(text[end])) {
      out += text.slice(from, at) + REDACTED
      from = end
    }
    at = text.indexOf(needle, Math.max(end, at + 1))
  }
  return out + text.slice(from)
}

/** The value as written raw and as a vendor would echo it inside a JSON-quoted string. */
const echoForms = (value: string): ReadonlyArray<string> => {
  const quoted = JSON.stringify(value).slice(1, -1)
  return quoted === value ? [value] : [value, quoted]
}

/** Redact the env values an issue is about: its own variable, or every variable at the root. */
const redactMessage = (message: string, path: ReadonlyArray<string | number>, env: EnvLike): string => {
  const root = path[0]
  const keys = root === undefined ? Object.keys(env) : [String(root)]
  const values = keys
    .map((key) => env[key])
    .filter((value): value is string => value !== undefined && value !== "")
    .flatMap(echoForms)
    // Longest first, so a value that contains another is redacted whole.
    .toSorted((a, b) => b.length - a.length)
  return values.reduce(redactToken, message)
}

/**
 * Validate the environment with a Standard Schema. Values arrive as `string` (empty strings
 * are dropped as unset); coerce numbers in the schema and parse booleans strictly (see the
 * module doc). Issue messages never echo the value of the variable they are reported against.
 * The default `env` is `process.env` where it exists and `{}` elsewhere.
 */
export function parseEnv<S extends StandardSchemaV1>(
  schema: S,
  env?: EnvLike
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> {
  const source = envRecord(env)
  const result = parse(schema, source)
  if (result.ok) return result
  return err(ValidationFailure({
    issues: result.error.issues.map((issue) => ({
      ...issue,
      message: redactMessage(issue.message, issue.path, source)
    }))
  }))
}

/** The provided record, else the live `process.env`, else `{}` (no `process` global). */
export function envRecord(overrides?: EnvLike): EnvLike {
  if (overrides !== undefined) return overrides
  // Node-only default; edge runtimes pass `import.meta.env` explicitly.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env !== undefined ? proc.env : {}
}
