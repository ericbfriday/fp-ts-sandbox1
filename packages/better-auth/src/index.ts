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
 * Normalization: both lanes collapse to one `AuthError` vocabulary (RFC 0001 §2):
 * 401 → `Unauthenticated`, 403 → `Forbidden`, any other status → `AuthApiError` (with `status`).
 * Better Auth's machine-readable `code` is kept on all three.
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
import { APIError, isAPIError } from "better-auth/api"

/** `code` carries Better Auth's machine-readable error code when the 401 came from Better Auth. */
export const Unauthenticated: ErrorFactory<"Unauthenticated", { code?: string }> = taggedError("Unauthenticated")<
  { code?: string }
>()
export type Unauthenticated = ReturnType<typeof Unauthenticated>

/**
 * `required` names the missing role when `requireRole` rejects; a 403 from Better Auth names
 * no role, so it carries Better Auth's `code` instead.
 */
export const Forbidden: ErrorFactory<"Forbidden", { required?: string; code?: string }> = taggedError("Forbidden")<
  { required?: string; code?: string }
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

/**
 * One status→vocabulary mapping for both lanes (RFC 0001 §2 fixed vocabulary, §6 defaults):
 * 401 → `Unauthenticated`, 403 → `Forbidden`, anything else → `AuthApiError` with its status.
 * Better Auth's `code` rides along on all three (exactOptionalPropertyTypes: only when present).
 */
const fromStatus = (status: number, code: string | undefined): AuthError => {
  const props = code === undefined ? {} : { code }
  if (status === 401) return Unauthenticated(props)
  if (status === 403) return Forbidden(props)
  return AuthApiError({ status, ...props })
}

/**
 * Read `status`/`code` off an `isAPIError`-recognized error. Verified against better-call 1.4.5
 * `dist/error.mjs` (via better-auth 1.7.25): `name = "APIError"`, `status` is the string key
 * (`"UNAUTHORIZED"`) or a number, `statusCode` is always the numeric code, `body` is
 * `{ message?, code? }`. Read structurally so a second module copy maps the same way.
 */
const fromAPIError = (error: Parameters<typeof isAPIError>[0]): AuthError => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- shape verified above; every field is typeof-checked before use
  const raw = error as { status?: unknown; statusCode?: unknown; body?: { code?: unknown } | null }
  const status = typeof raw.statusCode === "number"
    ? raw.statusCode
    : typeof raw.status === "number"
    ? raw.status
    : 500
  const rawCode = raw.body !== null && typeof raw.body === "object" ? raw.body.code : undefined
  return fromStatus(status, typeof rawCode === "string" ? rawCode : undefined)
}

/**
 * Boundary triage shared by `authCall` and `requireSession`: a thrown `APIError` maps through
 * `fromStatus` (recognized via `isAPIError`, which falls back to `name === "APIError"`, so
 * duplicate `better-call` copies still match); our own tagged `Unauthenticated` passes through
 * as `Err`; anything else returns `undefined`, which core's tryAsync rethrows as `Panic` (the
 * defect convention).
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

/** Normalize the client tuple `{ data, error }` into a Result (same 401/403 mapping as `authCall`). */
export function fromAuthTuple<T>(tuple: { data: T | null; error: ClientAuthError | null }): Result<T, AuthError> {
  const { data, error } = tuple
  if (error !== null) {
    return err(fromStatus(typeof error.status === "number" ? error.status : 500, error.code))
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

/** Require a live session: missing session → `Err(Unauthenticated)`; APIError → `Err` via the 401/403 mapping; defects rethrow as `Panic`. */
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
 * `false` on `Err` and `{ data }` on `Ok`.
 *
 * `throwOnReject` (Design Report §5.6 item 4): `Err` throws a real Better Auth `APIError`
 * (`BAD_REQUEST`, `body.code` = the error's `_tag`, `body.message` = its `message` when present).
 * It must be an `APIError`: on sign-up (better-auth 1.7.25 `api/routes/sign-up.mjs`, run in the
 * tests) any other throw collapses into a generic 422 `FAILED_TO_CREATE_USER` and the tag is
 * lost; where no route-level catch exists, better-call 1.4.5's router (`dist/router.mjs`)
 * answers a non-`APIError` throw with a bare 500 (U: read from source, not run). The status is
 * a fixed 400 rather than a tag-derived one because sign-up rewrites a 403 `APIError` into its
 * generic duplicate-email response. The tagged error's `cause` is not forwarded (RFC 0001 §2).
 * Defects thrown by `validate` propagate as-is (the hook runner surfaces them).
 */
export function beforeDbHook<T, E extends TaggedError<string>>(
  validate: (data: T) => AsyncResult<T, E>,
  opts?: { throwOnReject?: boolean }
): (data: T) => Promise<false | { readonly data: T } | void> {
  return async (data: T) => {
    const r = await validate(data)
    if (r.ok) return { data: r.value }
    if (opts?.throwOnReject === true) {
      const { _tag: code, message } = r.error
      throw new APIError("BAD_REQUEST", message === undefined ? { code } : { code, message })
    }
    return false
  }
}
