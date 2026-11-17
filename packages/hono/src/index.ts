/**
 * `@friday-friday/hono` - Hono adapter (Design Report 5.2).
 *
 * Traps absorbed:
 * - The `hc` client infers responses only from chained routes and literal status codes;
 *   returning `c.json(x, status as number)` collapses the union. `respond` maps each tagged
 *   error to its LITERAL status via the `StatusMap` so `res.status` stays a narrow union and
 *   `await res.json()` narrows per status.
 * - `problem(e, status)` emits RFC 9457 `{ type, title, status, detail, tag, ...safeProps }`;
 *   the `tag` member lets `@friday-friday/http` reconstruct() rebuild the tagged error -
 *   Hono<->client round-trips are lossless.
 * - `sv(target, schema)` wraps hono sValidator with a hook that answers validation
 *   failures with a 422 Problem built from Standard Schema issues.
 * - `onErrorHandler` maps `HTTPException` to its own response (status AND headers preserved -
 *   the report marks header loss in onError as U, so it is a test case) and unknown throws
 *   to a sanitized 500 Problem (defects never leak internals).
 *
 * TS2589 guidance (report): split routes into sub-apps and export per-slice hc<typeof users>
 * clients; avoid one monolithic AppType.
 */
import type { Context, Env, ErrorHandler, MiddlewareHandler, TypedResponse, ValidationTargets } from "hono"
import { HTTPException } from "hono/http-exception"
// NOTE: the report names hono sValidator, but NO hono version ships it (verified 4.13.19 +
// 5.0.0-rc.1 exports maps: only ./validator) - sv is built directly on hono validator with
// Standard Schema manually, which also keeps the vendor-agnostic ~standard contract.
import { err, ok, type Result, type TaggedError, taggedError } from "@friday-friday/core"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { validator as honoValidator } from "hono/validator"

/** Map each tagged-error `_tag` to its literal status code - literals keep hc inference narrow. */
export type StatusMap<E extends TaggedError<string>> = { readonly [K in E["_tag"]]: ContentfulStatusCode }

/** RFC 9457 problem+json body; `tag` carries the original `_tag` for lossless reconstruction. */
export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
  readonly tag: string
  readonly [key: string]: unknown
}

/** Standard Schema result: `issues` present means failure (mirrors @standard-schema/spec). */
export type IssuePathSegment = PropertyKey | { readonly key: PropertyKey }

/** Spec-shaped issue (the subset sv consumes). */
export interface StandardIssue {
  readonly message?: string | undefined
  readonly path?: ReadonlyArray<IssuePathSegment> | undefined
}

export interface StandardResultLike<O = unknown> {
  readonly value?: O
  readonly issues?: ReadonlyArray<StandardIssue> | undefined
}

/** Minimal structural Standard Schema V1 view (validator side); mirrors @standard-schema/spec. */
export interface StandardSchemaV1Like<O = unknown> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResultLike<O> | Promise<StandardResultLike<O>>
  }
}

const statusTitles: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable"
}

/**
 * Build an RFC 9457 Problem from a tagged error: `_tag` becomes `tag`, error props become
 * extra members, `message` (when present) becomes `detail`. The error is plain data by
 * construction (IDEA.md 4.2), so everything except `message`/`cause` flows through safely.
 */
export function problem(e: TaggedError<string>, status: number): Problem {
  // oxlint-disable-next-line no-unsafe-type-assertion -- tagged errors are plain data (IDEA.md 4.2); message/cause are transport-excluded
  const { _tag, message, cause, ...safeProps } = e as TaggedError<string> & {
    message?: string
    cause?: unknown
    [key: string]: unknown
  }
  void cause
  return {
    type: "about:blank",
    title: statusTitles[status] ?? "Error",
    status,
    tag: _tag,
    ...(typeof message === "string" ? { detail: message } : {}),
    ...safeProps
  }
}

/**
 * Return a handler response from a Result, preserving status-literal unions:
 * Ok(v) -> c.json(v, 200); Err(e) -> c.json(problem(e, statuses[e._tag]), literalStatus).
 */
export function respond<T, E extends TaggedError<string>, const M extends StatusMap<E>>(
  c: Context,
  r: Result<T, E>,
  statuses: M
): Response & TypedResponse<T, 200, "json"> | Response & TypedResponse<Problem, M[E["_tag"]], "json"> {
  if (r.ok) {
    // oxlint-disable-next-line no-unsafe-type-assertion -- hono's c.json TypedResponse brand is structurally unsound to express; the return type above carries it
    return c.json(r.value, 200) as never
  }
  // E["_tag"] is narrowed to keyof M by the M extends StatusMap<E> constraint.
  const status: ContentfulStatusCode = statuses[r.error._tag as keyof M]
  // oxlint-disable-next-line no-unsafe-type-assertion -- same hono TypedResponse brand boundary as above
  return c.json(problem(r.error, status), status) as never
}

/** Normalize a spec path segment (PropertyKey | { key }) to a JSON-safe member. */
const pathSegment = (p: IssuePathSegment): string | number => {
  const key = typeof p === "object" && p !== null ? p.key : p
  return typeof key === "string" ? key : typeof key === "number" ? key : "[symbol]"
}

/** 422 Problem payload from Standard Schema issues. */
const validationProblem = (issues: ReadonlyArray<StandardIssue>): Problem => ({
  type: "about:blank",
  title: statusTitles[422] ?? "Unprocessable Content",
  status: 422,
  tag: "ValidationError",
  detail: issues.map((i) => i.message ?? "invalid").join("; "),
  issues: issues.map((i) => ({
    message: i.message ?? "invalid",
    path: i.path?.map(pathSegment)
  }))
})

/**
 * sv(target, schema) validates a target with Standard Schema; failures answer with a
 * 422 Problem (built from the ~standard issues) instead of hono's default plain-text
 * 400. Passing values return the parsed output so c.req.valid(target) works.
 */
/** Infer the Standard Schema output type through the validate-result value position. */
export type InferStandardOutput<S> = S extends StandardSchemaV1Like<infer O> ? O : never

/**
 * sv return type carries hono's in/out middleware metadata (the @hono/zod-validator
 * pattern) so handler inference keeps working - a bare MiddlewareHandler would make
 * valid() keys never.
 */
export type SvMiddleware<Target extends keyof ValidationTargets, Out> = MiddlewareHandler<
  Env,
  string,
  {
    in: { [K in Target]: ValidationTargets[Target] }
    out: { [K in Target]: Out }
  }
>

export function sv<Target extends keyof ValidationTargets, Schema extends StandardSchemaV1Like>(
  target: Target,
  schema: Schema
): SvMiddleware<Target, InferStandardOutput<Schema>> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- hono validator's generic shape cannot express the in/out metadata directly (zValidator uses the same boundary cast)
  return honoValidator(target as never, async (value: unknown, c) => {
    const r = await schema["~standard"].validate(value)
    if (r.issues !== undefined) {
      return c.json(validationProblem(r.issues), 422)
    }
    // oxlint-disable-next-line no-unsafe-type-assertion -- validated output is O by the Standard Schema contract
    return r.value as never
  }) as SvMiddleware<Target, InferStandardOutput<Schema>>
}

export interface OnErrorOptions {
  /** Report a defect (non-HTTPException throw) for observability; return value is ignored. */
  readonly report?: (cause: unknown) => void
}

const InternalError = taggedError("InternalError")<{ reason?: string }>()

/** Structural HTTPException check: survives duplicate hono copies (no instanceof reliance). */
const asHttpException = (e: unknown): HTTPException | null => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe: fields verified immediately below
  const candidate = e as { status?: unknown; getResponse?: unknown } | null
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.status === "number" &&
    typeof candidate.getResponse === "function"
  ) {
    // oxlint-disable-next-line no-unsafe-type-assertion -- structural shape verified field-by-field above
    return e as HTTPException
  }
  if (e instanceof HTTPException) return e
  return null
}

/**
 * onErrorHandler({ report }) - HTTPException responses pass through with their own
 * status AND headers (the report marks header loss in onError as U; the test suite
 * exercises it); unknown throws are sanitized to a 500 Problem (defects never leak).
 */
export function onErrorHandler(opts?: OnErrorOptions): ErrorHandler {
  return (err, c) => {
    const httpEx = asHttpException(err)
    if (httpEx !== null) return httpEx.getResponse()
    opts?.report?.(err)
    return c.json(problem(InternalError({ reason: "internal error" }), 500), 500)
  }
}

// Re-exported for ergonomic single-import handlers.
export { err, ok }
