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
  type ErrorFactory,
  ok,
  Panic,
  type Result,
  type TaggedError,
  taggedError,
  toThrowable
} from "@friday-friday/core"
import { parse, type ValidationFailure } from "@friday-friday/schema"
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

/** Pre-bound triage: `unstable_rethrow` runs before mapping, so sentinels are never swallowed. */
export function tryAsync<T, E>(fn: () => Promise<T>, opts: NextCatch<E>): AsyncResult<T, E> {
  return (async () => {
    try {
      return ok(await fn())
    } catch (cause) {
      nextRethrow(cause)
      const mapped = opts.catch(cause)
      if (mapped === undefined) throw cause instanceof Panic ? cause : new Panic(cause)
      return err(mapped)
    }
  })()
}

/** Sync twin of {@link tryAsync}. */
export function trySync<T, E>(fn: () => T, opts: NextCatch<E>): Result<T, E> {
  try {
    return ok(fn())
  } catch (cause) {
    nextRethrow(cause)
    const mapped = opts.catch(cause)
    if (mapped === undefined) throw cause instanceof Panic ? cause : new Panic(cause)
    return err(mapped)
  }
}

// ---------------------------------------------------------------------------
// Loaders: turn tagged Errs into Next.js control flow (report §5.1 "RSC loaders")
// ---------------------------------------------------------------------------

/** Loader helper: calls `notFound()` for `_tag: "NotFound"`, otherwise returns the Result. */
export function orNotFound<T>(r: Result<T, TaggedError<string>>): Result<T, TaggedError<string>> {
  if (!r.ok && r.error._tag === "NotFound") notFound()
  return r
}

/** Loader helper: calls `forbidden()` for `_tag: "Forbidden"` (behind experimental.authInterrupts). */
export function orForbidden<T>(r: Result<T, TaggedError<string>>): Result<T, TaggedError<string>> {
  if (!r.ok && r.error._tag === "Forbidden") forbidden()
  return r
}

/** Loader helper: redirects to `to` for `_tag: "Unauthenticated"`, otherwise returns the Result. */
export function orRedirect<T>(r: Result<T, TaggedError<string>>, to: string): Result<T, TaggedError<string>> {
  if (!r.ok && r.error._tag === "Unauthenticated") redirect(to)
  return r
}

/** Throws the tagged error as a real Error for error.tsx / `catchError`. */
export function orThrow<T>(r: Result<T, TaggedError<string>>): T {
  if (!r.ok) throw toThrowable(r.error)
  return r.value
}

// ---------------------------------------------------------------------------
// toResponse: route handlers (RFC-0001 §6 Problem Details)
// ---------------------------------------------------------------------------

export interface StatusMap {
  readonly [tag: string]: number | undefined
}

/**
 * Route-handler exit: `Ok` → `Response.json(value)`; `Err` → `application/problem+json` with the
 * tag-mapped status (RFC-0001 §6). Unmapped tags default to 500 as `InternalDefect`-shaped
 * problem details (`cause` and non-JSON-safe props are stripped before crossing the boundary).
 */
export function toResponse<T, E extends TaggedError<string>>(r: Result<T, E>, statuses?: StatusMap): Response {
  if (r.ok) return Response.json(r.value satisfies T)
  const tag = r.error._tag
  const status = statuses?.[tag] ?? defaultStatus(tag)
  return Response.json(problemBody(r.error, status), {
    status,
    headers: { "content-type": "application/problem+json" }
  })
}

const defaultStatus = (tag: string): number =>
  tag === "NotFound"
    ? 404
    : tag === "Forbidden"
    ? 403
    : tag === "Unauthenticated"
    ? 401
    : tag === "Conflict"
    ? 409
    : tag === "ValidationFailure"
    ? 422
    : 500

/** RFC-0001 §6 problem body: `cause` and non-JSON-safe props never cross the boundary. */
const problemBody = (error: TaggedError<string>, status: number): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    type: `https://friday-friday.dev/errors/${kebab(error._tag)}`,
    title: error._tag,
    status,
    tag: error._tag
  }
  if (error.message !== undefined) body["detail"] = error.message
  for (const [k, v] of Object.entries(error)) {
    if (k === "_tag" || k === "message" || k === "cause") continue
    try {
      JSON.stringify(v)
      body[k] = v
    } catch {
      // non-JSON-safe prop: stripped
    }
  }
  return body
}

const kebab = (tag: string): string => tag.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

// ---------------------------------------------------------------------------
// useActionState server actions (report §5.1 trap 3: throwing destroys form state)
// ---------------------------------------------------------------------------

/** Idle initial state for `useActionState(updateProfile, idle)`. */
export interface IdleActionState {
  readonly ok: null
}
export type ActionState<T, E extends TaggedError<string>> =
  | IdleActionState
  | Result<T, E | ValidationFailure | InternalDefect>

export interface InternalDefect extends TaggedError<"InternalDefect"> {
  readonly reason?: string
}
export const InternalDefect: ErrorFactory<"InternalDefect", { readonly reason?: string }> = taggedError(
  "InternalDefect"
)<{ reason?: string }>()

export interface ActionOptions<E extends TaggedError<string>> {
  /** Observe defects (they still return as `Err(InternalDefect)` data — never thrown). */
  readonly onDefect?: (cause: unknown) => void
  /** Extra triage mapping used INSIDE the action (sentinels still rethrow first). */
  readonly catch?: (cause: unknown) => E | undefined
}

export interface ActionFn<T, E extends TaggedError<string>> {
  (
    prev: ActionState<T, E>,
    formData: FormData
  ): Promise<ActionState<T, E>>
}

/**
 * Server Action wrapper for `useActionState`: validates the FormData with a Standard Schema,
 * runs the handler, and returns Results as DATA. Only defects reach the error lane — and even
 * those are returned as `Err(InternalDefect)` so form state survives (report §5.1 trap 3).
 * Sentinel safety: `unstable_rethrow` runs first in the triage, so `redirect()` after a save
 * (thrown outside any catch in the user handler) propagates.
 */
export function action<_S extends StandardSchemaV1, T, E extends TaggedError<string> = never>(
  schema: _S,
  handler: (input: StandardSchemaV1.InferOutput<_S>) => AsyncResult<T, E>,
  opts?: ActionOptions<E>
): ActionFn<T, E> {
  return async (_prev: ActionState<T, E>, formData: FormData): Promise<ActionState<T, E>> => {
    const raw: Record<string, string | File> = {}
    for (const [k, v] of formData.entries()) raw[k] = v
    const validated = parse(schema, raw)
    if (!validated.ok) return validated
    // Sentinel rethrow needs the exact caught value propagated; a bare `catch (e) { throw e }`
    // would trip no-useless-catch, so the flag form carries the distinction.
    let sentinel: unknown
    let rethrown = false
    try {
      return await handler(validated.value)
    } catch (cause) {
      try {
        nextRethrow(cause)
      } catch (e) {
        rethrown = true
        sentinel = e
      }
      if (rethrown) throw sentinel // framework control flow must win
      opts?.onDefect?.(cause)
      return err(InternalDefect({ reason: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
}

/** Re-export for loaders that need a real Error (error.tsx / catchError decoding). */
export { toThrowable } from "@friday-friday/core"
