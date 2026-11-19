/**
 * Golden RFC 9457 problem bodies for `@friday-friday/core/wire` (RFC-0001 §6, #33).
 *
 * Hand-written literals, NOT derived from the implementation: `toProblem(error, status, options)`
 * must produce exactly `body`. Adapter tickets (#37 hono, #38 trpc, #39 next, #40 http) import this
 * module as `@friday-friday/core/test/wire-golden` and assert their real HTTP/wire output against
 * the same bodies, instead of hand-copying fixtures that drift.
 *
 * Workspace-internal, test-only: the subpath exists only under the `@friday-friday/source`
 * condition (set by tsconfig `customConditions` and the Vitest config), and `test/` is not in the
 * package's `files`. Plain Node or a bundler without that condition gets
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` (asserted in `test/smoke.mjs`), so it is not runtime interface.
 */
import type { TaggedError } from "@friday-friday/core"
import type { Problem, ProblemOptions, StatusMap } from "@friday-friday/core/wire"

export interface GoldenProblem {
  readonly name: string
  /** Input error (may carry `cause` and non-JSON-safe props on purpose). */
  readonly error: TaggedError<string>
  /** Second argument to `toProblem`; omitted = RFC §6 default table. */
  readonly status?: number | StatusMap
  /** Third argument to `toProblem` (`strict`, `safeProps`); omitted = none. */
  readonly options?: ProblemOptions
  /** The exact body `toProblem(error, status)` must return. */
  readonly body: Problem
}

const t = (tag: string, props: Record<string, unknown>): TaggedError<string> => ({ _tag: tag, ...props })

export const goldenProblems: ReadonlyArray<GoldenProblem> = [
  {
    name: "default status from the RFC §6 table; message → detail",
    error: t("NotFound", { resource: "user", id: "42", message: "no such user" }),
    body: {
      type: "https://friday-friday.dev/errors/not-found",
      title: "Not Found",
      status: 404,
      detail: "no such user",
      tag: "NotFound",
      resource: "user",
      id: "42"
    }
  },
  {
    name: "status map hit",
    error: t("Timeout", { ms: 500 }),
    status: { Timeout: 504, NotFound: 404 },
    body: {
      type: "https://friday-friday.dev/errors/timeout",
      title: "Timeout",
      status: 504,
      tag: "Timeout",
      ms: 500
    }
  },
  {
    name: "a tag with no status (not in the map, not in the RFC §6 table) is masked as InternalDefect",
    error: t("ReplicaLagging", { host: "db.internal:5432", message: "replica 30s behind" }),
    status: { NotFound: 404 },
    body: {
      type: "https://friday-friday.dev/errors/internal-defect",
      title: "Internal Defect",
      status: 500,
      detail: "Internal server error",
      tag: "InternalDefect"
    }
  },
  {
    name: "an explicit status keeps a tag the RFC §6 table doesn't list",
    error: t("RateLimited", { retryAfter: 30, message: "slow down" }),
    status: 429,
    body: {
      type: "https://friday-friday.dev/errors/rate-limited",
      title: "Rate Limited",
      status: 429,
      detail: "slow down",
      tag: "RateLimited",
      retryAfter: 30
    }
  },
  {
    name: "infrastructure default (ADR-0005): DbUnavailable → 503",
    error: t("DbUnavailable", { message: "database unavailable" }),
    body: {
      type: "https://friday-friday.dev/errors/db-unavailable",
      title: "Db Unavailable",
      status: 503,
      detail: "database unavailable",
      tag: "DbUnavailable"
    }
  },
  {
    name: "infrastructure default (ADR-0005): Timeout → 504, also filling a gap in a map",
    error: t("Timeout", { ms: 500 }),
    status: { NotFound: 404 },
    body: {
      type: "https://friday-friday.dev/errors/timeout",
      title: "Timeout",
      status: 504,
      tag: "Timeout",
      ms: 500
    }
  },
  {
    name: "infrastructure default (ADR-0005): NetworkError → 502",
    error: t("NetworkError", { reason: "ECONNRESET" }),
    body: {
      type: "https://friday-friday.dev/errors/network-error",
      title: "Network Error",
      status: 502,
      tag: "NetworkError",
      reason: "ECONNRESET"
    }
  },
  {
    name: "reserved-member collisions are carried in `shadowed`; the real status/type win",
    error: t("AuthApiError", {
      status: 401,
      type: "session",
      title: "Session",
      detail: "raw detail",
      instance: "/login",
      tag: "auth",
      shadowed: true,
      code: "SESSION_EXPIRED",
      message: "session expired"
    }),
    status: 500,
    body: {
      type: "https://friday-friday.dev/errors/auth-api-error",
      title: "Auth Api Error",
      status: 500,
      detail: "session expired",
      tag: "AuthApiError",
      code: "SESSION_EXPIRED",
      shadowed: {
        status: 401,
        type: "session",
        title: "Session",
        detail: "raw detail",
        instance: "/login",
        tag: "auth",
        shadowed: true
      }
    }
  },
  {
    name: "cause and non-JSON-safe props never reach the body",
    error: t("Conflict", {
      field: "email",
      attempts: 3n,
      retry: () => undefined,
      at: new Date("2026-11-17T00:00:00.000Z"),
      cause: new Error("duplicate key value violates unique constraint \"users_email_key\"")
    }),
    body: {
      type: "https://friday-friday.dev/errors/conflict",
      title: "Conflict",
      status: 409,
      tag: "Conflict",
      field: "email",
      at: "2026-11-17T00:00:00.000Z"
    }
  },
  {
    name: "validation failure: issues are plain data, root path stays []",
    error: t("ValidationFailure", {
      issues: [{ path: ["email"], message: "Invalid email" }, { path: [], message: "Passwords differ" }]
    }),
    body: {
      type: "https://friday-friday.dev/errors/validation-failure",
      title: "Validation Failure",
      status: 422,
      tag: "ValidationFailure",
      issues: [{ path: ["email"], message: "Invalid email" }, { path: [], message: "Passwords differ" }]
    }
  },
  {
    name: "strict: a tag missing from the caller's map is masked even if the RFC §6 table lists it",
    error: t("NotFound", { resource: "user", id: "42", message: "no such user" }),
    status: { Conflict: 409 },
    options: { strict: true },
    body: {
      type: "https://friday-friday.dev/errors/internal-defect",
      title: "Internal Defect",
      status: 500,
      detail: "Internal server error",
      tag: "InternalDefect"
    }
  },
  {
    name: "strict: an infrastructure tag missing from the caller's map is masked too",
    error: t("DbUnavailable", { message: "connection refused" }),
    status: { NotFound: 404 },
    options: { strict: true },
    body: {
      type: "https://friday-friday.dev/errors/internal-defect",
      title: "Internal Defect",
      status: 500,
      detail: "Internal server error",
      tag: "InternalDefect"
    }
  },
  {
    name: "a safeProps allowlist lets only the named props through (message still maps to detail)",
    error: t("Unauthenticated", {
      code: "SESSION_EXPIRED",
      status: 401,
      headers: { authorization: "Bearer abc" },
      message: "session expired"
    }),
    options: { safeProps: ["code", "status"] },
    body: {
      type: "https://friday-friday.dev/errors/unauthenticated",
      title: "Unauthenticated",
      status: 401,
      detail: "session expired",
      tag: "Unauthenticated",
      code: "SESSION_EXPIRED",
      shadowed: { status: 401 }
    }
  },
  {
    name: "a non-error status (2xx/3xx/out of range) falls back to the tag default",
    error: t("Forbidden", { message: "admins only" }),
    status: 200,
    body: {
      type: "https://friday-friday.dev/errors/forbidden",
      title: "Forbidden",
      status: 403,
      detail: "admins only",
      tag: "Forbidden"
    }
  },
  {
    name: "acronyms in the tag stay one word",
    error: t("HTTPError", {}),
    status: 502,
    body: {
      type: "https://friday-friday.dev/errors/http-error",
      title: "HTTP Error",
      status: 502,
      tag: "HTTPError"
    }
  },
  {
    name: "the defect envelope (what toDefect returns) as a problem",
    error: t("InternalDefect", { message: "Internal server error" }),
    body: {
      type: "https://friday-friday.dev/errors/internal-defect",
      title: "Internal Defect",
      status: 500,
      detail: "Internal server error",
      tag: "InternalDefect"
    }
  }
]
