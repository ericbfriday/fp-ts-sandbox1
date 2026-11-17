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
 * Wrap a server-side `auth.api.*` call: `APIError` → `Err(AuthApiError)` (via `isAPIError`,
 * NOT instanceof — duplicate `better-call` copies break that), anything else → defect, rethrown.
 */
export function authCall<T>(f: () => Promise<T>): AsyncResult<T, AuthError> {
  return (async () => {
    try {
      return ok(await f())
    } catch (cause) {
      if (isAPIError(cause)) return err(fromAPIError(cause))
      throw cause
    }
  })()
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
  readonly user: { readonly id: string; readonly role?: string }
}

/** Require a live session: `null` session → `Unauthenticated`; APIError → `AuthApiError`. */
export function requireSession(
  auth: AuthLike,
  headers: Headers
): AsyncResult<SessionLike, AuthError> {
  return (async () => {
    try {
      const result = await auth.api.getSession({ headers })
      if (result === null || result === undefined) return err(Unauthenticated({}))
      const candidate = result as Partial<SessionLike>
      if (candidate.session === undefined || candidate.user === undefined) return err(Unauthenticated({}))
      // oxlint-disable-next-line no-unsafe-type-assertion -- Partial<SessionLike> verified field-by-field just above
      return ok(candidate as SessionLike)
    } catch (cause) {
      if (isAPIError(cause)) return err(fromAPIError(cause))
      throw cause
    }
  })()
}

/**
 * Require a role for an existing session (better-auth stores `user.role` as a comma-separated
 * string by convention; arrays are also accepted). `Err(Forbidden)` names the required role.
 */
export function requireRole(required: string): (session: SessionLike) => Result<SessionLike, Forbidden> {
  return (session) => {
    const role = session.user.role
    const roles = typeof role === "string" ? role.split(",").map((r) => r.trim()) : Array.isArray(role) ? role : []
    if (!roles.includes(required)) return err(Forbidden({ required }))
    return ok(session)
  }
}

export interface DatabaseHookResult<T> {
  /** `false` aborts the database operation (better-auth databaseHooks contract). */
  readonly abort: false
  readonly data: T
}

/**
 * Adapt an AsyncResult validator into a better-auth `databaseHooks.*.before` hook:
 * `Err` → `false` (abort; or throws `APIError`-shaped when `throwOnReject`),
 * `Ok` → `{ data }` (replace). Defects propagate as `Panic`.
 */
export function beforeDbHook<T, E extends TaggedError<string>>(
  validate: (data: T) => AsyncResult<T, E>,
  opts?: { throwOnReject?: boolean }
): (data: T) => Promise<DatabaseHookResult<T>["data"] | DatabaseHookResult<T> | false | undefined> {
  return async (data: T) => {
    const r = await validate(data)
    if (r.ok) return { abort: false as const, data: r.value }
    if (opts?.throwOnReject === true) {
      throw taggedErrorHook(r.error)
    }
    return false
  }
}

const taggedErrorHook = (e: unknown): never => {
  throw e
}
