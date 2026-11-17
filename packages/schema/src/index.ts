/**
 * `@friday-friday/schema` — Standard Schema validation → Result (Design Report §5.7).
 *
 * `@standard-schema/spec` is a TYPES-ONLY dependency: nothing is imported at runtime, so no
 * vendor (Zod/Valibot/ArkType) is ever a hard dependency — any Standard Schema V1 implementation
 * works. Reports §Key finding 3 (spec 1.1 adds `StandardTypedV1` / `StandardJSONSchemaV1`).
 *
 * Paths are normalized from `PropertyKey | { key }` segments to `string | number`; symbol
 * segments are dropped and noted inline as `"[symbol]"` placeholders (RFC: "dropped and noted").
 * `cause` stays server-side per RFC §2 — ValidationFailure carries no cause by construction.
 */

import {
  type AsyncResult,
  err,
  type ErrorFactory,
  ok,
  Panic,
  type Result,
  type TaggedError,
  taggedError
} from "@friday-friday/core"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

// Types-only re-export: adapters compose Standard Schema without re-declaring the shape
// (types-only vendor deps are allowed; see IDEA.md section 9).
export type { StandardJSONSchemaV1, StandardSchemaV1 }

/** One projected issue: the ONLY fields that ever cross a boundary (RFC-0001 §5.3). */
export interface ValidationIssue {
  readonly message: string
  /** Property-key path; root-level issues have `[]` (never `undefined`). */
  readonly path: ReadonlyArray<string | number>
}

export interface ValidationFailure extends TaggedError<"ValidationFailure"> {
  readonly issues: ReadonlyArray<ValidationIssue>
}

export const ValidationFailure: ErrorFactory<
  "ValidationFailure",
  { issues: ReadonlyArray<{ message: string; path: ReadonlyArray<string | number> }> }
> = taggedError("ValidationFailure")<{
  issues: ReadonlyArray<{ message: string; path: ReadonlyArray<string | number> }>
}>()
export type ValidationFailureInstance = ReturnType<typeof ValidationFailure>

export interface Unsupported extends TaggedError<"Unsupported"> {
  readonly reason: string
}
export const Unsupported: ErrorFactory<"Unsupported", { reason: string }> = taggedError("Unsupported")<{
  reason: string
}>()

type PathPart = string | number

/** Normalize a Standard Schema issue path (PropertyKey | {key} segments) to `string | number`. */
const normalizePath = (path: NonNullable<StandardSchemaV1.Issue["path"]>): ReadonlyArray<PathPart> =>
  path.map((segment) => {
    const key = typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment
    return typeof key === "symbol" ? "[symbol]" : key
  })

/**
 * The issue projection: the single producer of `ValidationFailure` (`parse`/`parseAsync` use it,
 * and adapters such as hono `sv` and the tRPC `errorFormatter` call it instead of re-declaring
 * the shape — Design Report §5.3 "format from Standard Schema issues", §5.7).
 *
 * Contract:
 * - input: Standard Schema V1 issues (`~standard.validate(...).issues`), from any vendor;
 * - output: a `ValidationFailure` whose issues are NEW objects with exactly `{ message, path }`;
 *   vendor extras (`input`, `expected`, `received`, `kind`, path-segment `input`/`value`, …)
 *   are dropped, so the submitted input never rides along to a client;
 * - `path` is normalised to property keys (`{ key }` segments unwrapped, symbols noted as
 *   `"[symbol]"`); a missing path is the root, `[]`;
 * - no `cause` (RFC-0001 §2); pure, never throws for spec-shaped issues.
 *
 * The vendor-authored `message` is kept verbatim (some vendors' default messages quote the
 * received value — choose messages accordingly for secret fields).
 */
export function toValidationFailure(issues: ReadonlyArray<StandardSchemaV1.Issue>): ValidationFailure {
  return ValidationFailure({
    issues: issues.map((issue) => ({
      message: issue.message,
      path: Array.isArray(issue.path) ? normalizePath(issue.path) : []
    }))
  })
}

const toResult = <S extends StandardSchemaV1>(
  result: StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> =>
  result.issues === undefined ? ok(result.value) : err(toValidationFailure(result.issues))

// A vendor `validate` that throws is a defect (IDEA §4.3, RFC-0001 §3): rethrown as `Panic` with
// the original as `cause`; an existing Panic passes through. Local until core exposes its one
// idempotent "to Panic" conversion (#30 solution item 3).
const toPanic = (cause: unknown): Panic => (cause instanceof Panic ? cause : new Panic(cause))

const orPanic = <T>(thunk: () => T): T => {
  try {
    return thunk()
  } catch (cause) {
    throw toPanic(cause)
  }
}

/**
 * Synchronous parse. Throws `Panic` if the schema validates asynchronously — use `parseAsync`
 * (the spec's `~standard.validate` returns a Promise for async vendors) — or if the vendor's
 * `validate` itself throws (a defect, `cause` = the original throw).
 */
export function parse<S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> {
  const result = orPanic(() => schema["~standard"].validate(input))
  if (result instanceof Promise) {
    throw new Panic("parse() received an async-validating schema; use parseAsync()")
  }
  return toResult(result)
}

/**
 * Async parse: awaits the validation result (works for sync and async vendors alike).
 * Never throws synchronously: a vendor `validate` that throws or rejects is a defect, so the
 * returned promise REJECTS with `Panic` (`cause` = the original); invalid input is `Err`.
 */
export async function parseAsync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): AsyncResult<StandardSchemaV1.InferOutput<S>, ValidationFailure> {
  try {
    return toResult(await schema["~standard"].validate(input))
  } catch (cause) {
    throw toPanic(cause)
  }
}

/**
 * What the readers accept: a `ValidationFailure`, or one rebuilt from the wire whose issues may
 * lack `path` (e.g. a JSON round-trip of a producer that omitted root paths). A missing or
 * non-array path is read as the root.
 */
export interface ValidationFailureLike {
  readonly issues: ReadonlyArray<{
    readonly message: string
    readonly path?: ReadonlyArray<string | number> | null | undefined
  }>
}

/**
 * Group failure issues into per-field message lists, keyed by the "."-joined path
 * (root-level issues — empty or missing path — are keyed `"_errors"`).
 */
export function toFieldErrors(failure: ValidationFailureLike): Record<string, Array<string>> {
  const out: Record<string, Array<string>> = {}
  for (const issue of failure.issues) {
    const key = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "_errors"
    const bucket = out[key]
    if (bucket === undefined) out[key] = [issue.message]
    else bucket.push(issue.message)
  }
  return out
}

/**
 * Form-shaped view of a failure: `toFieldErrors` with the `"_errors"` (root) bucket always
 * present. Matches the `zod.flatten()`-style shape forms expect from `setErrorMap`-style consumers.
 */
export function toFormErrors(failure: ValidationFailureLike): Record<string, Array<string>> {
  return { _errors: [], ...toFieldErrors(failure) }
}

// ---------------------------------------------------------------------------
// Brands (RFC-0001 §5.7 / Design Report §3.6 — phantom type, zero runtime cost)
// ---------------------------------------------------------------------------

/**
 * Phantom brand key: type-level only, never present at runtime. Exported TYPE-ONLY
 * (`import { type brand }`): a value export of a `declare const` type-checks but fails at
 * runtime with a SyntaxError, because no such binding exists in the emitted JS (#32).
 */
declare const brand: unique symbol
export type { brand }

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export interface Branded<S extends StandardSchemaV1, B extends string> {
  (input: unknown): Result<Brand<StandardSchemaV1.InferOutput<S>, B>, ValidationFailure>
}

/**
 * Validate with `schema`, then stamp the phantom brand on the (already-validated) value.
 * The brand is a compile-time marker only — nothing is added to the object at runtime, so
 * wire contracts are unaffected. (Spec source: Design Report §5.7.)
 */
export function branded<const B extends string, S extends StandardSchemaV1>(
  schema: S,
  // `_tag` names the brand for type-level readability; the runtime impl never reads it
  // (the phantom brand is type-only, see `Brand`).
  _tag: B
): Branded<S, B> {
  return (input: unknown): Result<Brand<StandardSchemaV1.InferOutput<S>, B>, ValidationFailure> => {
    const result = parse(schema, input)
    if (!result.ok) return result
    // The value is already validated; the brand is a phantom type-level marker (no runtime key),
    // so this assertion stamps the type without touching the data. Same deliberate idiom as All.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above
    return ok(result.value as Brand<StandardSchemaV1.InferOutput<S>, B>)
  }
}

// ---------------------------------------------------------------------------
// JSON Schema conversion via StandardJSONSchemaV1 (spec 1.1; conversion may throw)
// ---------------------------------------------------------------------------

export interface ToJsonSchema {
  (
    schema: StandardJSONSchemaV1,
    io: "input" | "output",
    target?: "draft-2020-12" | "draft-07"
  ): Result<object, Unsupported>
}

/**
 * Convert a `StandardJSONSchemaV1` implementation to a JSON Schema document. The spec says the
 * converter "may throw if conversion is not supported" — wrapped as `Err(Unsupported)`.
 */
export const toJsonSchema: ToJsonSchema = (schema, io, target): Result<object, Unsupported> => {
  try {
    const jsonSchema = schema["~standard"].jsonSchema
    const t = target ?? "draft-2020-12"
    const doc = io === "input" ? jsonSchema.input({ target: t }) : jsonSchema.output({ target: t })
    return ok(doc)
  } catch (cause) {
    return err(Unsupported({ reason: cause instanceof Error ? cause.message : String(cause) }))
  }
}
