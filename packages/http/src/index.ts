/**
 * `@friday-friday/http` — HTTP client adapter (Design Report §5.9).
 *
 * `fetchResult(url, { schema, signal, timeoutMs, retries })` returns
 * `AsyncResult<T, HttpError | NetworkError | Timeout | ValidationFailure>`.
 *
 * Round-trip contract: a non-2xx `application/problem+json` (RFC 9457) body is kept raw on
 * `HttpError.problem`, and `reconstruct()` rebuilds the server's tagged error from it through
 * core's wire parse-back (`@friday-friday/core/wire` `fromWire`, RFC-0001 §6), the same module
 * every producer builds the body with, so the round-trip is lossless by construction.
 *
 * Abort semantics follow core (IDEA §4.3, `/async` module doc): a user abort rejects with `Panic`
 * and is never retried; `Timeout` means the `timeoutMs` timer fired, nothing else.
 */
import { type AsyncResult, err, type ErrorFactory, ok, type Result, taggedError, toPanic } from "@friday-friday/core"
import { Timeout as timeoutFactory } from "@friday-friday/core/async"
import { fromWire, type WireError } from "@friday-friday/core/wire"

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
 * Rebuild the server's tagged error from a problem+json body by delegating to core's wire
 * parse-back (`fromWire`, RFC-0001 §6; decision note 2026-11-17-core-wire-subpath), so the
 * round-trip with every producer (next `toResponse`, hono `problem`) is lossless: `_tag` from
 * `tag`, `message` from `detail`, safe props, and props that collided with reserved members
 * (carried in `shadowed`). A problem without `tag` falls back to core's status inverse
 * (`404 → NotFound`, …). Returns `null` when the body can't be attributed to a tag.
 */
export function reconstruct(problem: ProblemBody | undefined): WireError | null {
  return fromWire(problem) ?? null
}

/** Structural probe of an untrusted JSON body (no cast: `Reflect.get` reads any object). */
const isProblemBody = (body: unknown): body is ProblemBody =>
  typeof body === "object" && body !== null &&
  ["type", "title", "tag"].some((k) => typeof Reflect.get(body, k) === "string")

export interface FetchOptions {
  /** Standard Schema validated against a 2xx JSON body (via `@friday-friday/schema`). */
  readonly schema?: unknown
  /**
   * Forwarded to `fetch` (combined with `timeoutMs` via `AbortSignal.any`). A user abort is a
   * defect, as everywhere in core (`tryAsync`, `/async` `timeout`): the promise rejects with
   * `Panic(signal.reason)`, wherever the abort lands (before the request, in flight, while the
   * body is read, during a retry backoff), and it is never retried.
   */
  readonly signal?: AbortSignal
  /** Per-attempt budget; only when this timer fires is the failure `Err(Timeout{ms})` (core's convention). */
  readonly timeoutMs?: number
  /** Retry attempts for transport failures (NetworkError/Timeout); NOT for 4xx/5xx responses or aborts. */
  readonly retries?: number
}

/** Backoff; a user abort cuts it short with `Panic(abort reason)` (IDEA §4.3, core `/async`). */
const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(toPanic(signal.reason))
    }, { once: true })
  })

/**
 * `fetch` as an AsyncResult. Transport errors → `Err(NetworkError)`; the `timeoutMs` timer →
 * `Err(Timeout{ms})`; non-2xx → `Err(HttpError)` with the parsed problem body (if any; rebuild
 * the server's tagged error with `reconstruct`); 204/205 → `Ok(undefined)`; other 2xx → schema
 * decode (`Err(ValidationFailure)` on mismatch) then `Ok(json)`, where an empty body is
 * `undefined`. A user abort rejects with `Panic` (see `FetchOptions.signal`).
 */
export function fetchResult<T>(url: string, opts?: FetchOptions): AsyncResult<T, FetchError> {
  return (async () => {
    for (let attempt = 0;; attempt++) {
      const r = await attempt_<T>(url, opts)
      // Retry only transport-shaped failures; HTTP status failures are terminal, aborts throw.
      if (r.ok || (r.error._tag !== "NetworkError" && r.error._tag !== "Timeout") || attempt >= (opts?.retries ?? 0)) {
        return r
      }
      await sleep(50 * 2 ** attempt, opts?.signal)
    }
  })()
}

const reasonOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const attempt_ = async <T>(url: string, opts: FetchOptions | undefined): Promise<Result<T, FetchError>> => {
  const user = opts?.signal
  const ms = opts?.timeoutMs
  const budget = ms === undefined ? undefined : AbortSignal.timeout(ms)
  const signal = budget === undefined ? user : user === undefined ? budget : AbortSignal.any([user, budget])
  // Which signal fired decides what a failed fetch/body read means: the user's → defect (thrown
  // first, so a user abort is never reported as Timeout); the timer's → Timeout; neither → undefined.
  // An already-aborted signal lands here too: `fetch` rejects before sending anything.
  const aborted = (): Result<never, TimeoutError> | undefined => {
    if (user?.aborted) throw toPanic(user.reason)
    return budget?.aborted === true && ms !== undefined ? err(timeoutFactory({ ms })) : undefined
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
    return aborted() ?? err(NetworkError({ reason: reasonOf(cause) }))
  }
  // RFC 9110 §15.3.5/§15.3.6: 204 and 205 carry no content, so there is nothing to decode.
  // oxlint-disable-next-line no-unsafe-type-assertion -- no content: T is the caller's contract (e.g. `fetchResult<void>`)
  if (res.status === 204 || res.status === 205) return ok(undefined as T)
  let text: string
  try {
    text = await res.text()
  } catch (cause) {
    return aborted() ??
      (res.ok ? err(NetworkError({ reason: reasonOf(cause) })) : err(HttpError({ status: res.status })))
  }
  if (!res.ok) {
    let problem: ProblemBody | undefined
    try {
      const body: unknown = JSON.parse(text)
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
    // An empty body is `undefined`: Ok as is, or decoded by the schema like any other body.
    json = text === "" ? undefined : JSON.parse(text)
  } catch (cause) {
    return err(NetworkError({ reason: `invalid JSON body: ${reasonOf(cause)}` }))
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
