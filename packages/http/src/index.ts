/**
 * `@friday-friday/http` — HTTP client adapter (Design Report §5.9).
 *
 * `fetchResult(url, { schema, signal, timeoutMs, retries })` returns
 * `AsyncResult<T, HttpError | NetworkError | Timeout | ValidationFailure>`.
 *
 * Round-trip contract (lossless with `@friday-friday/next`'s `toResponse` and
 * `@friday-friday/hono`'s `problem`): a non-2xx response whose body is
 * `application/problem+json` (RFC 9457) carries the original error `_tag` in the
 * `tag` member; `HttpError` embeds the raw problem object and `reconstruct()`
 * rebuilds the plain tagged error from it — tagged errors are plain data, so the
 * rebuilt object deep-equals the one the server failed with.
 */
import { type AsyncResult, err, type ErrorFactory, ok, type Result, taggedError } from "@friday-friday/core"
import { Timeout as timeoutFactory } from "@friday-friday/core/async"

// `Timeout` in core/async is a merged value+interface name; derive the tagged-error TYPE from the
// value so FetchError carries the Err payload shape, not the options interface.
type TimeoutError = ReturnType<typeof timeoutFactory>
import { parseAsync, type ValidationFailure } from "@friday-friday/schema"

export const NetworkError: ErrorFactory<"NetworkError", { readonly reason: string }> = taggedError(
  "NetworkError"
)<{ readonly reason: string }>()
export type NetworkError = ReturnType<typeof NetworkError>

/** RFC 9457 problem+json body, as received. `tag` is our extension carrying the server error `_tag`. */
export interface ProblemBody {
  readonly type?: string
  readonly title?: string
  readonly status?: number
  readonly detail?: string
  /** Our extension: the `_tag` of the error the server reduced to this problem. */
  readonly tag?: string
  readonly [key: string]: unknown
}

export const HttpError: ErrorFactory<"HttpError", { readonly status: number; readonly problem?: ProblemBody }> =
  taggedError(
    "HttpError"
  )<{ readonly status: number; readonly problem?: ProblemBody }>()
export type HttpError = ReturnType<typeof HttpError>

export type FetchError = HttpError | NetworkError | TimeoutError | ValidationFailure

/**
 * Rebuild the server's tagged error from a problem+json body: plain data in,
 * plain data out (`{ _tag: tag, ...safeProps }`). Returns null when the body
 * carries no `tag` (foreign problem or non-problem body).
 */
export function reconstruct(
  problem: ProblemBody | undefined
): { readonly _tag: string } & Record<string, unknown> | null {
  if (problem === undefined || typeof problem.tag !== "string") return null
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `tag`/`type` are transport metadata, not error props
  const { tag, type, title, status, detail, ...safeProps } = problem
  return { _tag: tag, ...safeProps }
}

// Structural probe of an untrusted JSON body; the casts below are the boundary where the
// wire shape is verified field-by-field before it is trusted.
// oxlint-disable-next-line no-unsafe-type-assertion
const asRecord = (body: unknown): Record<string, unknown> =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- boundary probe: fields verified immediately below
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
const isProblemBody = (body: unknown): body is ProblemBody => {
  const b = asRecord(body)
  return typeof b["type"] === "string" || typeof b["title"] === "string" || typeof b["tag"] === "string"
}

export interface FetchOptions {
  /** Standard Schema validated against a 2xx JSON body (via `@friday-friday/schema`). */
  readonly schema?: unknown
  /** Forwarded to `fetch`; combined with `timeoutMs` via `AbortSignal.any` where available. */
  readonly signal?: AbortSignal
  /** Whole-request budget; expiry surfaces as `Err(Timeout{ms})` (core's convention). */
  readonly timeoutMs?: number
  /** Retry attempts for transport failures (NetworkError/Timeout); NOT for 4xx/5xx responses. */
  readonly retries?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `fetch` as an AsyncResult. Transport errors → `Err(NetworkError)`; non-2xx →
 * `Err(HttpError)` with the parsed problem body (if any); 2xx → schema decode
 * (`Err(ValidationFailure)` on mismatch) then `Ok(json)`.
 */
export function fetchResult<T>(url: string, opts?: FetchOptions): AsyncResult<T, FetchError> {
  return (async () => {
    const attempts = (opts?.retries ?? 0) + 1
    let last: Result<T, FetchError> | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const r = await attempt_<T>(url, opts)
      // Retry only transport-shaped failures; HTTP status failures are terminal.
      const transport = !r.ok && (r.error._tag === "NetworkError" || r.error._tag === "Timeout")
      if (r.ok || !transport) return r
      last = r
      if (attempt < attempts - 1) await sleep(50 * 2 ** attempt)
    }
    // oxlint-disable-next-line no-unsafe-type-assertion -- attempts >= 1 guarantees last is set
    return last as Result<T, FetchError>
  })()
}

const attempt_ = async <T>(url: string, opts: FetchOptions | undefined): Promise<Result<T, FetchError>> => {
  let signal = opts?.signal
  if (opts?.timeoutMs !== undefined) {
    const budget = AbortSignal.timeout(opts.timeoutMs)
    signal = signal === undefined ? budget : AbortSignal.any([signal, budget])
  }
  let res: Response
  try {
    res = await fetch(
      url,
      signal === undefined
        ? { headers: { accept: "application/json" } }
        : { signal, headers: { accept: "application/json" } }
    )
  } catch (cause) {
    // Distinguish timeout-budget expiry from other transport failures.
    // oxlint-disable-next-line no-unsafe-type-assertion -- signal is defined whenever timeoutMs is
    if (opts?.timeoutMs !== undefined && (signal as AbortSignal).aborted) {
      return err(timeoutFactory({ ms: opts.timeoutMs }))
    }
    return err(NetworkError({ reason: cause instanceof Error ? cause.message : String(cause) }))
  }
  if (!res.ok) {
    let problem: ProblemBody | undefined
    try {
      const body: unknown = await res.json()
      if (isProblemBody(body)) problem = body
    } catch {
      // non-JSON body: HttpError without problem details
    }
    return problem === undefined
      ? err(HttpError({ status: res.status }))
      : err(HttpError({ status: res.status, problem }))
  }
  let json: unknown
  try {
    json = await res.json()
  } catch (cause) {
    return err(
      NetworkError({ reason: cause instanceof Error ? `invalid JSON body: ${cause.message}` : "invalid JSON body" })
    )
  }
  if (opts?.schema !== undefined) {
    // oxlint-disable-next-line no-unsafe-type-assertion -- schema is validated as StandardSchemaV1 at the boundary; keep the adapter generic
    const decoded: Result<unknown, ValidationFailure> = await parseAsync(opts.schema as never, json)
    if (!decoded.ok) return err(decoded.error)
    // oxlint-disable-next-line no-unsafe-type-assertion -- schema decode guarantees the T shape (adapter contract)
    return ok(decoded.value as T)
  }
  // oxlint-disable-next-line no-unsafe-type-assertion -- no-schema mode: T is the caller's raw-JSON contract
  return ok(json as T)
}
