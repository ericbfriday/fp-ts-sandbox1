/**
 * `@friday-friday/better-auth` — Better Auth adapter (Design Report §5.6).
 *
 * Traps absorbed:
 * - The server `auth.api.*` THROWS `APIError`; `instanceof APIError` fails across duplicate
 *   `better-call` copies — `isAPIError` from `better-auth/api` is the structural check.
 * - The client returns `{ data, error }` tuples with `error.status`/`code` instead of throwing.
 * - Cookies need `returnHeaders: true` when calling the server API outside a request handler.
 * - `databaseHooks` signal via `false` (abort), `{ data }` (replace) or a thrown `APIError`.
 *
 * Normalization: both lanes collapse to one `AuthError` vocabulary:
 * `Unauthenticated` | `Forbidden` | `AuthApiError` (with `status`/`code`).
 */
import {
  type AsyncResult,
  err,
  type ErrorFactory,
  ok,
  type Result,
  type TaggedError,
  taggedError
} from "@friday-friday/core"
import { tryAsync } from "@friday-friday/core/async"
import { isAPIError } from "better-auth/api"

export const Unauthenticated: ErrorFactory<"Unauthenticated", {}> = taggedError("Unauthenticated")()
export type Unauthenticated = ReturnType<typeof Unauthenticated>

export const Forbidden: ErrorFactory<"Forbidden", { required: string }> = taggedError("Forbidden")<
  { required: string }
>()
export type Forbidden = ReturnType<typeof Forbidden>

export interface AuthApiError extends TaggedError<"AuthApiError"> {
  readonly status: number
  readonly code?: string
}
export const AuthApiError: ErrorFactory<"AuthApiError", { status: number; code?: string }> = taggedError(
  "AuthApiError"
)<{ status: number; code?: string }>()
export type AuthApiErrorInstance = ReturnType<typeof AuthApiError>

export type AuthError = Unauthenticated | Forbidden | AuthApiErrorInstance

/** Extract `status`/`code` from an `isAPIError`-recognized error (better-call attaches them). */
const fromAPIError = (error: Parameters<typeof isAPIError>[0]): AuthApiErrorInstance => {
  // better-call APIError: `status` (string code or number), `statusCode` (number), `body` = { message?, code?, cause? }.
  // oxlint-disable-next-line no-unsafe-type-assertion -- better-call APIError shape is runtime-verified (error.mjs): status/statusCode + body.code
  const raw = error as { status?: unknown; statusCode?: unknown; body?: { code?: unknown } | null }
  const status = typeof raw.statusCode === "number"
    ? raw.statusCode
    : typeof raw.status === "number"
    ? raw.status
    : 500
  const rawCode = raw.body !== null && typeof raw.body === "object" ? raw.body.code : undefined
  const code = typeof rawCode === "string" ? rawCode : undefined
  return code === undefined ? AuthApiError({ status }) : AuthApiError({ status, code })
}

/**
 * Boundary triage shared by `authCall` and `requireSession`: a thrown `APIError` maps to
 * `Err(AuthApiError)` (via `isAPIError` — structural, NOT instanceof: duplicate `better-call`
 * copies break that); our own tagged `Unauthenticated` passes through as `Err`; anything else
 * returns `undefined`, which core's tryAsync rethrows as `Panic` (the defect convention).
 */
const triageAuthError = (cause: unknown): AuthError | undefined => {
  if (isAPIError(cause)) return fromAPIError(cause)
  if (Unauthenticated.is(cause)) return cause
  return undefined
}

/** Wrap a server-side `auth.api.*` call; defects rethrow as `Panic`. */
export function authCall<T>(f: () => Promise<T>): AsyncResult<T, AuthError> {
  return tryAsync(f, { catch: triageAuthError })
}

export interface ClientAuthError {
  readonly status: number
  readonly message?: string
  readonly code?: string
}

/** Normalize the client tuple `{ data, error }` into a Result. */
export function fromAuthTuple<T>(tuple: { data: T | null; error: ClientAuthError | null }): Result<T, AuthError> {
  const { data, error } = tuple
  if (error !== null) {
    // exactOptionalPropertyTypes: only pass `code` through when present.
    return error.code === undefined
      ? err(AuthApiError({ status: typeof error.status === "number" ? error.status : 500 }))
      : err(AuthApiError({ status: typeof error.status === "number" ? error.status : 500, code: error.code }))
  }
  if (data === null) {
    return err(Unauthenticated({}))
  }
  return ok(data)
}

/** Minimal structural `auth` view used by `requireSession` (avoids importing the full type). */
export interface AuthLike {
  api: {
    getSession(input: { headers: Headers }): Promise<unknown>
  }
}

/** Session shape sufficient for `requireSession`/`requireRole` (better-auth session + user). */
export interface SessionLike {
  readonly session: unknown
  /** Comma-separated string (better-auth convention) or an explicit role array. */
  readonly user: { readonly id: string; readonly role?: string | ReadonlyArray<string> }
}

/** Require a live session: missing session → `Err(Unauthenticated)`; APIError → `Err(AuthApiError)`; defects rethrow as `Panic`. */
export function requireSession(
  auth: AuthLike,
  headers: Headers
): AsyncResult<SessionLike, AuthError> {
  return tryAsync(
    async () => {
      const result = await auth.api.getSession({ headers })
      if (result === null || result === undefined) throw Unauthenticated({})
      const candidate = result as Partial<SessionLike>
      if (candidate.session === undefined || candidate.user === undefined) throw Unauthenticated({})
      // oxlint-disable-next-line no-unsafe-type-assertion -- Partial<SessionLike> verified field-by-field just above
      return candidate as SessionLike
    },
    { catch: triageAuthError }
  )
}

/**
 * Require a role for an existing session (better-auth stores `user.role` as a comma-separated
 * string by convention; arrays are also accepted). `Err(Forbidden)` names the required role.
 */
export function requireRole(required: string): (session: SessionLike) => Result<SessionLike, Forbidden> {
  return (session) => {
    const role = session.user.role
    const roles = typeof role === "string" ? role.split(",").map((r) => r.trim()) : Array.isArray(role) ? [...role] : []
    if (!roles.includes(required)) return err(Forbidden({ required }))
    return ok(session)
  }
}

/**
 * Adapt an AsyncResult validator into a better-auth `databaseHooks.*.before` hook.
 * The vendored contract (better-auth 1.7.25, `init-options.d.mts` + `with-hooks.mjs`) is
 * `Promise<boolean | void | { data }>`: the runner only checks `=== false` (abort) and
 * `"data" in result` (replace) — there is no `abort` field, so the adapter emits exactly
 * `false` on `Err` (or throws the tagged error when `throwOnReject`) and `{ data }` on `Ok`.
 * Defects thrown by `validate` propagate as-is (the hook runner surfaces them).
 */
export function beforeDbHook<T, E extends TaggedError<string>>(
  validate: (data: T) => AsyncResult<T, E>,
  opts?: { throwOnReject?: boolean }
): (data: T) => Promise<false | { readonly data: T } | void> {
  return async (data: T) => {
    const r = await validate(data)
    if (r.ok) return { data: r.value }
    if (opts?.throwOnReject === true) throw r.error
    return false
  }
}
