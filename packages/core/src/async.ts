/**
 * `@friday-friday/core/async` — the async subpath (RFC-0001 §4).
 *
 * - Inputs accept `Result | Promise<Result>` where sensible; every function returns
 *   `Promise<Result>` (`AsyncResult`).
 * - Defects stay defects: a rejecting thunk or mapper propagates as `Panic`, never as `Err`.
 * - Plain data in, plain data out: outputs survive `JSON` and `structuredClone` unchanged.
 * - Cancellation convention (documented choices, RFC §4 / Design Report §3.6):
 *   - `timeout()` translates a timeout abort into `Err(Timeout)`.
 *   - a *user* signal abort is a defect: `Panic(abort reason)`.
 *   - `retry()` is the exception: an abort mid-retry returns the *last* `Err` when one exists
 *     (the domain error that got us here), and throws `Panic` only if nothing had settled yet.
 */

import {
  type AsyncResult,
  err,
  type ErrorFactory,
  ok,
  Panic,
  type Result,
  taggedError,
  type TryOptions
} from "./index.js"
import { call, dual } from "./internal.js"

/** A `Result` that may already be wrapped in a promise. */
type AsyncInput<T, E> = Result<T, E> | Promise<Result<T, E>>

/** A value that may be produced synchronously or asynchronously. */
type MaybePromise<V> = V | Promise<V>

/** Infrastructure tag for a `timeout()` boundary (RFC-0001 §2 infrastructure errors).
 * Follows the RFC §2 usage pattern: explicit ErrorFactory annotation + ReturnType twin type. */
export const Timeout: ErrorFactory<"Timeout", { ms: number }> = taggedError("Timeout")<{ ms: number }>()
export type TimeoutError = ReturnType<typeof Timeout>

// ---------------------------------------------------------------------------
// Async-aware duals of the sync combinators
// ---------------------------------------------------------------------------

export interface MapAsync {
  <T, U>(f: (value: T) => MaybePromise<U>): <E = never>(r: AsyncInput<T, E>) => AsyncResult<U, E>
  <T, U, E = never>(r: AsyncInput<T, E>, f: (value: T) => MaybePromise<U>): AsyncResult<U, E>
}
export const mapAsync: MapAsync = dual(
  (r: AsyncInput<unknown, unknown>, f: (value: unknown) => unknown): Promise<Result<unknown, unknown>> =>
    (async () => {
      const res = await r
      return res.ok ? ok(await call(f, res.value)) : res
    })()
)

export interface AndThenAsync {
  <T, U, E2>(f: (value: T) => AsyncInput<U, E2>): <E = never>(r: AsyncInput<T, E>) => AsyncResult<U, E | E2>
  <T, U, E = never, E2 = never>(r: AsyncInput<T, E>, f: (value: T) => AsyncInput<U, E2>): AsyncResult<U, E | E2>
}
export const andThenAsync: AndThenAsync = dual(
  (
    r: AsyncInput<unknown, unknown>,
    f: (value: unknown) => AsyncInput<unknown, unknown>
  ): Promise<Result<unknown, unknown>> =>
    (async () => {
      const res = await r
      return res.ok ? await call(f, res.value) : res
    })()
)

export interface OrElseAsync {
  <E, U, E2>(f: (error: E) => AsyncInput<U, E2>): <T>(r: AsyncInput<T, E>) => AsyncResult<T | U, E2>
  <T, E, U, E2>(r: AsyncInput<T, E>, f: (error: E) => AsyncInput<U, E2>): AsyncResult<T | U, E2>
}
export const orElseAsync: OrElseAsync = dual(
  (
    r: AsyncInput<unknown, unknown>,
    f: (error: unknown) => AsyncInput<unknown, unknown>
  ): Promise<Result<unknown, unknown>> =>
    (async () => {
      const res = await r
      return res.ok ? res : await call(f, res.error)
    })()
)

export interface TapAsync {
  <T>(f: (value: T) => MaybePromise<void>): <E = never>(r: AsyncInput<T, E>) => AsyncResult<T, E>
  <T, E = never>(r: AsyncInput<T, E>, f: (value: T) => MaybePromise<void>): AsyncResult<T, E>
}
export const tapAsync: TapAsync = dual(
  (r: AsyncInput<unknown, unknown>, f: (value: unknown) => unknown): Promise<Result<unknown, unknown>> =>
    (async () => {
      const res = await r
      if (res.ok) await call(f, res.value)
      return res
    })()
)

export interface TapErrAsync {
  <E>(f: (error: E) => MaybePromise<void>): <T = never>(r: AsyncInput<T, E>) => AsyncResult<T, E>
  <T, E>(r: AsyncInput<T, E>, f: (error: E) => MaybePromise<void>): AsyncResult<T, E>
}
export const tapErrAsync: TapErrAsync = dual(
  (r: AsyncInput<unknown, unknown>, f: (error: unknown) => unknown): Promise<Result<unknown, unknown>> =>
    (async () => {
      const res = await r
      if (!res.ok) await call(f, res.error)
      return res
    })()
)

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export interface AllAsync {
  <T, E>(thunks: ReadonlyArray<() => AsyncResult<T, E>>): AsyncResult<Array<T>, E>
}

/** Run every thunk concurrently; select the first `Err` in INPUT order (defects reject immediately). */
export const allAsync: AllAsync = /*#__PURE__*/ async <T, E>(
  thunks: ReadonlyArray<() => AsyncResult<T, E>>
): Promise<Result<Array<T>, E>> => {
  const settled = await Promise.all(
    thunks.map((thunk) =>
      Promise.resolve()
        .then(thunk)
        .catch((cause: unknown) => {
          throw new Panic(cause)
        })
    )
  )
  const values: Array<T> = []
  for (const r of settled) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
}

export interface MapConcurrentOptions {
  /** Maximum concurrently in-flight mapper invocations. Clamped to ≥ 1. */
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface MapConcurrent {
  <T, U, E>(
    inputs: ReadonlyArray<T>,
    mapper: (input: T, index: number) => AsyncResult<U, E>,
    opts: MapConcurrentOptions
  ): AsyncResult<Array<U>, E>
}

/**
 * Map `mapper` over `inputs` with at most `opts.limit` in flight; select the first `Err` in
 * INPUT order. Runs to completion (an early `Err` does not abort in-flight work) — documented
 * choice for v1; `opts.signal` aborting is a defect (`Panic(abort reason)`).
 */
export const mapConcurrent: MapConcurrent = async <T, U, E>(
  inputs: ReadonlyArray<T>,
  mapper: (input: T, index: number) => AsyncResult<U, E>,
  opts: MapConcurrentOptions
): Promise<Result<Array<U>, E>> => {
  const limit = Math.max(1, Math.floor(opts.limit))
  const results: Array<Result<U, E>> = new Array(inputs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      if (opts.signal?.aborted) throw new Panic(opts.signal.reason ?? "aborted")
      const index = next++
      results[index] = await Promise.resolve(mapper(inputs[index]!, index)).catch((cause: unknown) => {
        throw new Panic(cause)
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker))
  const values: Array<U> = []
  for (const r of results) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
}

// ---------------------------------------------------------------------------
// Retry / timeout — cancellation and resource safety (Design Report §3.6)
// ---------------------------------------------------------------------------

export interface RetryOptions<E> {
  /** Number of RETRIES after the first attempt (total attempts = times + 1). */
  readonly times: number
  /** Fixed ms between attempts, or `"exponential"` for 250ms * 2^attempt backoff. */
  readonly delay?: number | "exponential"
  /** Keep retrying only while this returns true for the latest `Err`. */
  readonly while?: (e: E) => boolean
  /** Aborting mid-retry returns the LAST `Err` (see module doc); checked before each delay/attempt. */
  readonly signal?: AbortSignal
}

export interface Retry {
  <T, E>(fn: () => AsyncResult<T, E>, opts: RetryOptions<E>): AsyncResult<T, E>
}

/**
 * Retry on `Err` VALUES only — a defect (`Panic`) propagates immediately, never retried.
 * `delay: "exponential"` = 250ms * 2^attempt. Abort semantics: see `RetryOptions.signal`.
 */
export const retry: Retry = async <T, E>(
  fn: () => AsyncResult<T, E>,
  opts: RetryOptions<E>
): Promise<Result<T, E>> => {
  // Defects (any rejection) are wrapped as Panic and NEVER retried: the wrapper below throws
  // through the loop, out of `retry`.
  const attempt = (): Promise<Result<T, E>> =>
    Promise.resolve()
      .then(fn)
      .catch((cause: unknown) => {
        throw new Panic(cause)
      })
  // Abort before anything settled: there is no last Err to return, so this is a defect.
  if (opts.signal?.aborted) throw new Panic(opts.signal.reason ?? "aborted")
  let result = await attempt()
  for (let attemptNo = 0; !result.ok && attemptNo < opts.times; attemptNo++) {
    if (opts.while && !opts.while(result.error)) break
    if (opts.signal?.aborted) return result
    if (opts.delay !== undefined) {
      const ms = opts.delay === "exponential" ? 250 * 2 ** attemptNo : opts.delay
      try {
        await sleep(ms, opts.signal)
      } catch {
        return result
      }
      if (opts.signal?.aborted) return result
    }
    result = await attempt()
  }
  return result
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Panic(signal.reason ?? "aborted"))
      },
      { once: true }
    )
  })

export interface Timeout {
  <T, E>(thunk: () => AsyncResult<T, E>, ms: number, signal?: AbortSignal): AsyncResult<T, E | TimeoutError>
}

/**
 * Bound a thunk by `ms` via `AbortSignal.timeout`, composed with an optional user signal via
 * `AbortSignal.any`. Timing out yields `Err(Timeout({ ms }))`; a USER signal abort is a defect
 * (`Panic(abort reason)`); thunk defects propagate as `Panic`.
 */
export const timeout: Timeout = async <T, E>(
  thunk: () => AsyncResult<T, E>,
  ms: number,
  signal?: AbortSignal
): Promise<Result<T, E | TimeoutError>> => {
  const timeoutSignal = AbortSignal.timeout(ms)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let settled = false
  const abortPromise = new Promise<never>((_, reject) => {
    combined.addEventListener(
      "abort",
      () => {
        if (!settled) reject(new Panic(combined.reason ?? "aborted"))
      },
      { once: true }
    )
  })
  abortPromise.catch(() => {}) // never an unhandled rejection when the thunk wins the race
  try {
    const result = await Promise.race([Promise.resolve(thunk()), abortPromise])
    settled = true
    return result
  } catch (cause) {
    settled = true
    if (timeoutSignal.aborted && !signal?.aborted) return err(Timeout({ ms }))
    throw cause instanceof Panic ? cause : new Panic(cause)
  }
}

// ---------------------------------------------------------------------------
// Boundary triage (async half, RFC-0001 §3)
// ---------------------------------------------------------------------------

export interface TryAsync {
  <T, E>(fn: (signal?: AbortSignal) => Promise<T>, opts: TryOptions<E>): AsyncResult<T, E>
}

/**
 * The async half of boundary triage: `opts.signal` is forwarded into `fn`; on rejection
 * `rethrow` runs first (framework sentinels), then `catch` maps the cause — returning
 * `undefined` means "defect", rethrown as `Panic`.
 */
export const tryAsync: TryAsync = async <T, E>(
  fn: (signal?: AbortSignal) => Promise<T>,
  opts: TryOptions<E>
): Promise<Result<T, E>> => {
  try {
    return ok(await fn(opts.signal))
  } catch (cause) {
    opts.rethrow?.(cause)
    const mapped = call(opts.catch, cause)
    if (mapped === undefined) throw new Panic(cause)
    return err(mapped)
  }
}
