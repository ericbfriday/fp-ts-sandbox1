/**
 * `@friday-friday/tanstack-start` - TanStack Start/Router adapter (Design Report 5.5).
 *
 * Traps absorbed:
 * - **#6428 workaround (re-checked 2026-11-17: still OPEN).** Start validator failures lose
 *   issue structure during serialization (issues array becomes a JSON string inside
 *   error.message). resultHandler validates INSIDE the handler with @friday-friday/schema:
 *   a failure is returned as Err(ValidationFailure) DATA with structured issues; domain
 *   errors are also data; only defects throw.
 * - **Sentinels must not be wrapped.** loaderResult throws Router notFound() / redirect()
 *   sentinels for mapped tags - user try/catch around loaders must let them through (they
 *   are control flow, not errors).
 * - **Form:** pass Standard Schemas straight to validators; map a server
 *   Err(ValidationFailure) into form.setErrorMap with toFormErrors. Check _tag
 *   structurally - never instanceof ServerValidateError. (Track Form v2 alpha's
 *   validator-array change before adapter 1.0.)
 * - **Store:** use useSelector - useStore is deprecated as of Store 0.11.
 *
 * Composition (the vendor surface stays in user code; the adapter is vendor-light):
 *   export const createPost = createServerFn({ method: "POST" })
 *     .validator((d: unknown) => d)   // pass-through; real validation below
 *     .handler(({ data }) => resultHandler(PostSchema, (input) => posts.create(data, input)))
 * Direct server-fn calls skip validators (router #7507) - resultHandler validating inside
 * means unit tests exercise validation too.
 */
import { type AsyncResult, err, Panic, type Result, type TaggedError } from "@friday-friday/core"
import { parseAsync, type StandardSchemaV1, toFormErrors, type ValidationFailure } from "@friday-friday/schema"
import { notFound, redirect } from "@tanstack/router-core"

/** Re-exported so server fns and forms share one vocabulary. */
export { toFormErrors } from "@friday-friday/schema"
export type { ValidationFailure } from "@friday-friday/schema"

/** The validated output of a Standard Schema V1. */
export type StandardSchemaInfer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

/**
 * Server-fn handler wrapper (the #6428 workaround): validates data INSIDE the handler.
 * - validation failure -> Err(ValidationFailure) with structured issues (DATA, not thrown)
 * - handler Ok -> Ok(value) as data; handler Err(e) -> Err(e) as data
 * - handler defects (throws) propagate - only defects throw
 */
export function resultHandler<S extends StandardSchemaV1, T, E extends TaggedError<string>>(
  schema: S,
  handler: (input: StandardSchemaInfer<S>) => AsyncResult<T, E>
): (args: { readonly data: unknown }) => AsyncResult<T, E | ValidationFailure> {
  return async ({ data }) => {
    const r = await parseAsync(schema, data)
    if (!r.ok) return err(r.error)
    try {
      return await handler(r.value)
    } catch (cause) {
      // Only defects throw - and they throw as Panic (the repo defect convention).
      throw cause instanceof Panic ? cause : new Panic(cause)
    }
  }
}

/** Positional alias kept for the report's resultServerFn(schema, handler) naming. */
export const resultServerFn: typeof resultHandler = resultHandler

export interface LoaderResultOptions {
  /** Tag mapped to Router notFound() sentinel. Default: "NotFound". */
  readonly notFoundTag?: string
  /** Tag mapped to Router redirect() sentinel. Default: "Unauthenticated". */
  readonly redirectTag?: string
  /** Where redirect() sends the user. Default: "/login". */
  readonly redirectTo?: string
}

/**
 * Loader bridge: unwrap a Result for a TanStack Router loader.
 * - Ok(v) -> v (the loader data)
 * - mapped tags -> Router sentinels THROWN (notFound() / redirect({ to })) - these are
 *   Router control flow and must not be wrapped in user try/catch
 * - other Err(e) -> thrown as Panic whose cause carries the tagged error, so
 *   errorComponent can decode it losslessly (Panic.cause is plain data).
 */
export function loaderResult<T, E extends TaggedError<string>>(
  r: Result<T, E>,
  opts?: LoaderResultOptions
): Promise<T> {
  if (r.ok) return Promise.resolve(r.value)
  const notFoundTag = opts?.notFoundTag ?? "NotFound"
  const redirectTag = opts?.redirectTag ?? "Unauthenticated"
  const to = opts?.redirectTo ?? "/login"
  if (r.error._tag === notFoundTag) throw notFound()
  if (r.error._tag === redirectTag) throw redirect({ to })
  throw new Panic(r.error)
}

// Form helper passthrough (documented alias so call sites read as adapter usage).
export { toFormErrors as formErrorMap }
