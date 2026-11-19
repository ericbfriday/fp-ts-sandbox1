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
> = /*#__PURE__*/ taggedError("ValidationFailure")<{
  issues: ReadonlyArray<{ message: string; path: ReadonlyArray<string | number> }>
}>()
export type ValidationFailureInstance = ReturnType<typeof ValidationFailure>

export interface Unsupported extends TaggedError<"Unsupported"> {
  readonly reason: string
}
export const Unsupported: ErrorFactory<"Unsupported", { reason: string }> = /*#__PURE__*/ taggedError("Unsupported")<{
  reason: string
}>()

type PathPart = string | number

/** A path segment as Standard Schema declares it, or as a wire/vendor may actually send it. */
type Segment = PropertyKey | StandardSchemaV1.PathSegment | null | undefined

/**
 * Normalize an issue path (PropertyKey | {key} segments) to `string | number`. Defensive
 * (review of #45): a missing/`null`/non-array path, or one with a nullish segment or key, is the
 * root `[]`
 * — an issue whose location is unknown is reported against the form, never a guessed field.
 */
const normalizePath = (path: ReadonlyArray<Segment> | null | undefined): ReadonlyArray<PathPart> => {
  const out: Array<PathPart> = []
  // `Array.isArray`, not `?? []`: a wire string path must not iterate as characters.
  for (const segment of Array.isArray(path) ? path : []) {
    const key = typeof segment === "object" && segment !== null ? segment.key : segment
    if (key == null) return []
    out.push(typeof key === "symbol" ? "[symbol]" : key)
  }
  return out
}

/** The message as a string, whatever arrived (a non-string from the wire; `String()` may throw). */
const toText = (message: unknown): string => {
  try {
    return String(message)
  } catch {
    return "[object]"
  }
}

/**
 * The issue shapes `toValidationFailure` accepts: Standard Schema V1 issues, and the
 * reader-shaped issues of a `ValidationFailureLike` (a wire-rebuilt failure, `path` maybe `null`).
 */
export interface IssueLike {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | null | undefined
}

/**
 * The issue projection: the single producer of `ValidationFailure` (`parse`/`parseAsync` use it,
 * and adapters such as hono `sv` and the tRPC `errorFormatter` call it instead of re-declaring
 * the shape — Design Report §5.3 "format from Standard Schema issues", §5.7).
 *
 * Contract:
 * - input: Standard Schema V1 issues (`~standard.validate(...).issues`), from any vendor, or
 *   reader-shaped issues rebuilt from the wire (`IssueLike`);
 * - output: a `ValidationFailure` whose issues are NEW objects with exactly `{ message, path }`;
 *   vendor extras (`input`, `expected`, `received`, `kind`, path-segment `input`/`value`, …)
 *   are dropped, so the submitted input never rides along to a client;
 * - `path` is normalised to property keys (`{ key }` segments unwrapped, symbols noted as
 *   `"[symbol]"`); a missing or `null` path, or one with a nullish segment, is the root, `[]`;
 * - `message` is always a string: a non-string is `String()`-ed (with a fixed fallback if that
 *   throws);
 * - no `cause` (RFC-0001 §2); pure, never throws for array input.
 *
 * The vendor-authored `message` is kept verbatim (some vendors' default messages quote the
 * received value — choose messages accordingly for secret fields).
 */
export function toValidationFailure(issues: ReadonlyArray<IssueLike>): ValidationFailure {
  return ValidationFailure({
    issues: issues.map((issue) => ({ message: toText(issue.message), path: normalizePath(issue.path) }))
  })
}

const toResult = <S extends StandardSchemaV1>(
  result: StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> =>
  result.issues === undefined ? ok(result.value) : err(toValidationFailure(result.issues))

// A vendor `validate` that throws is a defect (IDEA §4.3, RFC-0001 §3): rethrown as `Panic` with
// the original as `cause`; an existing Panic passes through. Local until core exposes its one
// idempotent "to Panic" conversion (#30 solution item 3).
// TODO(#47): replace with core's exported to-Panic conversion once PR #47 merges.
const toPanic = (cause: unknown): Panic => (cause instanceof Panic ? cause : new Panic(cause))

/**
 * Synchronous parse. Throws `Panic` if the schema validates asynchronously — use `parseAsync`
 * (the spec's `~standard.validate` returns a Promise for async vendors) — or if the vendor's
 * `validate` itself throws (a defect, `cause` = the original throw).
 */
export function parse<S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure> {
  try {
    const result = schema["~standard"].validate(input)
    // Any thenable is async, not just this realm's Promise (review of #45: `instanceof Promise`
    // let a cross-realm Promise or a vendor PromiseLike be read as a sync Result). Inline casts,
    // not a type-guard helper: env's 1 kB budget.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- probes an optional `then` only
    if (typeof (result as { then?: unknown }).then === "function") throw new Panic("async schema; use parseAsync")
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- not a thenable (checked above)
    return toResult(result as StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>)
  } catch (cause) {
    // A `null`/`undefined` result (vendor contract breach) fails the reads above: a defect too.
    throw toPanic(cause)
  }
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
  // A Map, not a `{}` accumulator (review of #45): a field named `constructor`, `toString` or
  // `__proto__` must not read an inherited member as its bucket or reassign a prototype.
  // `Object.fromEntries` defines every key as an OWN data property on a plain object, so even
  // `__proto__` is an ordinary key and nothing is polluted.
  const out = new Map<string, Array<string>>()
  for (const issue of failure.issues) {
    const key = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "_errors"
    const bucket = out.get(key)
    if (bucket === undefined) out.set(key, [issue.message])
    else bucket.push(issue.message)
  }
  return Object.fromEntries(out)
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
