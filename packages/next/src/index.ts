/**
 * `@friday-friday/next` — server helpers (react-server condition; Design Report §5.1).
 *
 * The default export condition of `.` is a stub that THROWS — server helpers must only load in
 * a React Server Component / Server Action environment. Client code imports `./client`.
 *
 * Traps absorbed (report §5.1): redirect()/notFound()/forbidden()/unauthorized() throw
 * sentinels that any try/catch swallows — `unstable_rethrow` runs FIRST in every triage here,
 * walking the `cause` chain to depth 5 defensively. Thrown Server Action errors destroy form
 * state, so `action()` returns Results as data and only defects throw.
 */

import {
  type AsyncResult,
  err,
  type InferErr,
  type InferOk,
  type Result,
  type Tagged,
  type TaggedError,
  trySync as coreTrySync
} from "@friday-friday/core"
import { tryAsync as coreTryAsync } from "@friday-friday/core/async"
import {
  type InternalDefect,
  PROBLEM_CONTENT_TYPE,
  type StatusMap,
  toDefect,
  toProblem
} from "@friday-friday/core/wire"
import { parseAsync, type ValidationFailure } from "@friday-friday/schema"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { forbidden, notFound, redirect, unstable_rethrow } from "next/navigation"

/** Walks a thrown cause chain (depth 5, per report §5.1 item 2) and hands every link to
 * `unstable_rethrow`, so framework sentinels rethrow before any mapping happens. */
export const nextRethrow = (cause: unknown): void => {
  for (
    let c: unknown = cause, i = 0;
    c !== null && c !== undefined && i < 5;
    c = (c as { cause?: unknown }).cause, i++
  ) {
    unstable_rethrow(c)
  }
}

export interface NextCatch<E> {
  /** Map an unknown throw to a domain error, or return `undefined` to treat it as a defect (rethrow). */
  readonly catch: (cause: unknown) => E | undefined
}

/** Pre-bound triage (report §5.1 snippet): delegates to core's tryAsync with nextRethrow, so
 * `unstable_rethrow` runs before mapping and sentinels are never swallowed. */
export function tryAsync<T, E>(fn: () => Promise<T>, opts: NextCatch<E>): AsyncResult<T, E> {
  return coreTryAsync(fn, { catch: opts.catch, rethrow: nextRethrow })
}

/** Sync twin of {@link tryAsync}, delegating to core's trySync with nextRethrow. */
export function trySync<T, E>(fn: () => T, opts: NextCatch<E>): Result<T, E> {
  return coreTrySync(fn, { catch: opts.catch, rethrow: nextRethrow })
}

// ---------------------------------------------------------------------------
// Loaders: turn tagged Errs into Next.js control flow (report §5.1 "RSC loaders")
// ---------------------------------------------------------------------------

/**
 * The one tag→sentinel table: each loader is named by its key, and its entry says which `_tag`
 * it handles and which Next sentinel that tag raises. The loaders below never name a tag; their
 * types read it from here, so adding or renaming a mapping is a one-line change.
 */
const sentinels = {
  orNotFound: { tag: "NotFound", raise: (_to: string): never => notFound() },
  orForbidden: { tag: "Forbidden", raise: (_to: string): never => forbidden() },
  orRedirect: { tag: "Unauthenticated", raise: (to: string): never => redirect(to) }
} as const

/** The Result a loader returns: `R`'s `T`, and `R`'s `E` without loader `L`'s tag. Inferring the
 * whole `R` (not `T`/`E` separately) keeps every Err member of a union argument in `E`. */
type Unhandled<R, L extends keyof typeof sentinels> = Result<
  InferOk<R>,
  Exclude<InferErr<R>, { readonly _tag: (typeof sentinels)[L]["tag"] }>
>

const interrupt = <L extends keyof typeof sentinels, R extends Result<unknown, Tagged>>(
  loader: L,
  r: R,
  to: string
): Unhandled<R, L> => {
  const { tag, raise } = sentinels[loader]
  if (!r.ok && r.error._tag === tag) raise(to)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an Err carrying `tag` raised above (raise returns never); a runtime compare cannot narrow R through Exclude
  return r as unknown as Unhandled<R, L>
}

/** Loader helper: calls `notFound()` for `_tag: "NotFound"`; otherwise returns the Result with `NotFound` removed from `E`. */
export function orNotFound<R extends Result<unknown, Tagged>>(r: R): Unhandled<R, "orNotFound"> {
  return interrupt("orNotFound", r, "")
}

/** Loader helper: calls `forbidden()` for `_tag: "Forbidden"` (behind experimental.authInterrupts); `Forbidden` leaves `E`. */
export function orForbidden<R extends Result<unknown, Tagged>>(r: R): Unhandled<R, "orForbidden"> {
  return interrupt("orForbidden", r, "")
}

/** Loader helper: redirects to `to` for `_tag: "Unauthenticated"`; `Unauthenticated` leaves `E`. */
export function orRedirect<R extends Result<unknown, Tagged>>(r: R, to: string): Unhandled<R, "orRedirect"> {
  return interrupt("orRedirect", r, to)
}

// ---------------------------------------------------------------------------
// toResponse: route handlers (RFC-0001 §6 Problem Details, via @friday-friday/core/wire)
// ---------------------------------------------------------------------------

/**
 * Route-handler exit: `Ok` → `Response.json(value)`; `Err` → the core wire module's RFC 9457 body
 * (`toProblem`) with `application/problem+json` and `body.status` as the HTTP status.
 *
 * Status: `statuses[tag]`, else the RFC-0001 §6 defaults (`NotFound 404`, `Forbidden 403`,
 * `Unauthenticated 401`, `Conflict 409`, `ValidationFailure 422`). A tag with no status is a defect:
 * the body is the fixed `InternalDefect` 500 and the original error goes to `opts.onDefect`. Props
 * are projected JSON-safe (`cause`, bigint, functions, … dropped); a prop named like a reserved
 * member (`status`, `type`, …) is carried in `shadowed`, so it can never overwrite the real status.
 */
export function toResponse<T, E extends TaggedError<string>>(
  r: Result<T, E>,
  statuses?: StatusMap,
  opts?: { readonly onDefect?: (cause: unknown) => void }
): Response {
  if (r.ok) return Response.json(r.value satisfies T)
  const report = opts?.onDefect
  const body = toProblem(r.error, statuses, report ? { report } : {})
  return Response.json(body, { status: body.status, headers: { "content-type": PROBLEM_CONTENT_TYPE } })
}

// ---------------------------------------------------------------------------
// useActionState server actions (report §5.1 trap 3: throwing destroys form state)
// ---------------------------------------------------------------------------

/** Idle initial state for `useActionState(updateProfile, idle)`. */
export interface IdleActionState {
  readonly ok: null
}
/** `E` from the handler, plus `ValidationFailure` (schema) and the core wire `InternalDefect` envelope. */
export type ActionState<T, E extends TaggedError<string>> =
  | IdleActionState
  | Result<T, E | ValidationFailure | InternalDefect>

export interface ActionOptions {
  /**
   * Observe defects (they still return as `Err(InternalDefect)` data — never thrown). Receives the
   * original cause; the browser never sees it. A throwing `onDefect` is swallowed.
   */
  readonly onDefect?: (cause: unknown) => void
}

export interface ActionFn<T, E extends TaggedError<string>> {
  (
    prev: ActionState<T, E>,
    formData: FormData
  ): Promise<ActionState<T, E>>
}

/**
 * FormData → plain input: a key sent once is its value (`string | File`); a key sent more than
 * once (`tags=a&tags=b`, multi-selects, checkbox groups) is the array of its values, in order.
 * So a field that MAY repeat must accept both shapes (e.g. `z.preprocess(toArray, z.array(…))`).
 * `Object.fromEntries` defines own data properties, so a `__proto__` field never sets a prototype.
 */
const fromFormData = (formData: FormData): Record<string, string | File | Array<string | File>> =>
  Object.fromEntries(
    Array.from(new Set(formData.keys()), (k) => {
      const all = formData.getAll(k)
      return [k, all.length === 1 ? all[0]! : all]
    })
  )

/**
 * Server Action wrapper for `useActionState`: validates the FormData with a Standard Schema
 * (`parseAsync`, so async-refining schemas work), runs the handler, and returns Results as DATA
 * (report §5.1 trap 3: a throw would destroy form state).
 *
 * - FormData: a repeated key becomes an array of its values; a single key stays a scalar.
 * - Invalid input → `Err(ValidationFailure)`.
 * - Triage (validation AND handler run inside it): `unstable_rethrow` runs first, walking the
 *   `cause` chain, so `redirect()`/`notFound()` thrown in the handler — also from inside a
 *   combinator such as `mapAsync`, which wraps it in `Panic` — propagate to Next. Any other throw
 *   (a handler defect, a vendor `validate` that throws) returns the core wire envelope
 *   `Err({ _tag: "InternalDefect", message: "Internal server error" })`; the original goes only to
 *   `opts.onDefect` (IDEA §4.3), never to the browser.
 */
export function action<_S extends StandardSchemaV1, T, E extends TaggedError<string> = never>(
  schema: _S,
  handler: (input: StandardSchemaV1.InferOutput<_S>) => AsyncResult<T, E>,
  opts?: ActionOptions
): ActionFn<T, E> {
  return async (_prev: ActionState<T, E>, formData: FormData): Promise<ActionState<T, E>> => {
    // Sentinel rethrow needs the exact caught value propagated; a bare `catch (e) { throw e }`
    // would trip no-useless-catch, so the flag form carries the distinction.
    let sentinel: unknown
    let rethrown = false
    try {
      const validated = await parseAsync(schema, fromFormData(formData))
      if (!validated.ok) return validated
      return await handler(validated.value)
    } catch (cause) {
      try {
        nextRethrow(cause)
      } catch (e) {
        rethrown = true
        sentinel = e
      }
      if (rethrown) throw sentinel // framework control flow must win
      return err(toDefect(cause, opts?.onDefect))
    }
  }
}
