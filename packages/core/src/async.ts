/**
 * `@friday-friday/core/async` — the async subpath (RFC-0001 §4).
 *
 * - Inputs accept `Result | Promise<Result>` where sensible; every function returns
 *   `Promise<Result>` (`AsyncResult`).
 * - Defects stay defects (IDEA §4.3): a callback, thunk, mapper or predicate that throws or
 *   rejects, and an input promise that rejects, propagates as `Panic` (via core's `toPanic`; an
 *   existing `Panic` passes through as the same instance), never as `Err`. Contract-tested in
 *   `test/defects.test.ts` across the sync, `/async` and `/gen` lanes.
 * - Plain data in, plain data out: outputs survive `JSON` and `structuredClone` unchanged.
 * - Signals (RFC §4 "all accept `{ signal }`", Design Report §3.6; see the RFC errata and the
 *   2026-11-16 decisions note):
 *   - cancellation-capable helpers take `{ signal }` and FORWARD it into the user callback/thunk
 *     so underlying work can actually observe cancellation: `allAsync`, `mapConcurrent`,
 *     `retry`, `timeout`, `tryAsync`;
 *   - pure duals (`mapAsync`, `andThenAsync`, `orElseAsync`, `tapAsync`, `tapErrAsync`) perform
 *     no cancellation of their own; callers bind their signal inside the callback closure.
 * - Abort semantics (documented choices):
 *   - `timeout()` translates a timeout abort into `Err(Timeout)`;
 *   - a *user* signal abort is a defect: `Panic(abort reason)`; a signal that is ALREADY aborted
 *     short-circuits `allAsync`, `mapConcurrent`, `retry` and `timeout` before any user code runs;
 *   - `retry()` is the exception: an abort mid-retry (between attempts, during a delay, or during
 *     an attempt whose fn rejects on abort) returns the *last* `Err` when one exists (the domain
 *     error that got us here), and throws `Panic` only if nothing had settled yet.
 */

import {
  type AsyncResult,
  err,
  type ErrorFactory,
  ok,
  type Result,
  taggedError,
  toPanic,
  type TryOptions
} from "./index.js"
import { call, callAsync, dual } from "./internal.js"

/** A `Result` that may already be wrapped in a promise. */
type AsyncInput<T, E> = Result<T, E> | Promise<Result<T, E>>

/** A value that may be produced synchronously or asynchronously. */
type MaybePromise<V> = V | Promise<V>

export interface SignalOptions {
  readonly signal?: AbortSignal
}

/** Infrastructure tag for a `timeout()` boundary (RFC-0001 §2 infrastructure errors).
 * Follows the RFC §2 usage pattern: explicit ErrorFactory annotation + ReturnType twin type. */
export const Timeout: ErrorFactory<"Timeout", { ms: number }> = taggedError("Timeout")<{ ms: number }>()
export type TimeoutError = ReturnType<typeof Timeout>

// ---------------------------------------------------------------------------
// Async-aware duals of the sync combinators (pure: no cancellation of their own)
// ---------------------------------------------------------------------------

export interface MapAsync {
  <T, U>(f: (value: T) => MaybePromise<U>): <E = never>(r: AsyncInput<T, E>) => AsyncResult<U, E>
  <T, U, E = never>(r: AsyncInput<T, E>, f: (value: T) => MaybePromise<U>): AsyncResult<U, E>
}
export const mapAsync: MapAsync = /*#__PURE__*/ dual(
  (r: AsyncInput<unknown, unknown>, f: (value: unknown) => unknown): Promise<Result<unknown, unknown>> =>
    callAsync(async () => {
      const res = await r
      return res.ok ? ok(await f(res.value)) : res
    })
)

export interface AndThenAsync {
  <T, U, E2>(f: (value: T) => AsyncInput<U, E2>): <E = never>(r: AsyncInput<T, E>) => AsyncResult<U, E | E2>
  <T, U, E = never, E2 = never>(r: AsyncInput<T, E>, f: (value: T) => AsyncInput<U, E2>): AsyncResult<U, E | E2>
}
export const andThenAsync: AndThenAsync = /*#__PURE__*/ dual(
  (
    r: AsyncInput<unknown, unknown>,
    f: (value: unknown) => AsyncInput<unknown, unknown>
  ): Promise<Result<unknown, unknown>> =>
    callAsync(async () => {
      const res = await r
      return res.ok ? await f(res.value) : res
    })
)

export interface OrElseAsync {
  <E, U, E2>(f: (error: E) => AsyncInput<U, E2>): <T>(r: AsyncInput<T, E>) => AsyncResult<T | U, E2>
  <T, E, U, E2>(r: AsyncInput<T, E>, f: (error: E) => AsyncInput<U, E2>): AsyncResult<T | U, E2>
}
export const orElseAsync: OrElseAsync = /*#__PURE__*/ dual(
  (
    r: AsyncInput<unknown, unknown>,
    f: (error: unknown) => AsyncInput<unknown, unknown>
  ): Promise<Result<unknown, unknown>> =>
    callAsync(async () => {
      const res = await r
      return res.ok ? res : await f(res.error)
    })
)

export interface TapAsync {
  <T>(f: (value: T) => MaybePromise<void>): <E = never>(r: AsyncInput<T, E>) => AsyncResult<T, E>
  <T, E = never>(r: AsyncInput<T, E>, f: (value: T) => MaybePromise<void>): AsyncResult<T, E>
}
export const tapAsync: TapAsync = /*#__PURE__*/ dual(
  (r: AsyncInput<unknown, unknown>, f: (value: unknown) => unknown): Promise<Result<unknown, unknown>> =>
    callAsync(async () => {
      const res = await r
      if (res.ok) await f(res.value)
      return res
    })
)

export interface TapErrAsync {
  <E>(f: (error: E) => MaybePromise<void>): <T = never>(r: AsyncInput<T, E>) => AsyncResult<T, E>
  <T, E>(r: AsyncInput<T, E>, f: (error: E) => MaybePromise<void>): AsyncResult<T, E>
}
export const tapErrAsync: TapErrAsync = /*#__PURE__*/ dual(
  (r: AsyncInput<unknown, unknown>, f: (error: unknown) => unknown): Promise<Result<unknown, unknown>> =>
    callAsync(async () => {
      const res = await r
      if (!res.ok) await f(res.error)
      return res
    })
)

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export interface AllAsync {
  <T, E>(
    thunks: ReadonlyArray<(signal?: AbortSignal) => AsyncResult<T, E>>,
    opts?: SignalOptions
  ): AsyncResult<Array<T>, E>
}

/**
 * Run every thunk concurrently (each receives `opts.signal`); select the first `Err` in INPUT
 * order. Defects reject immediately; an already-aborted signal is a defect (`Panic`).
 */
export const allAsync: AllAsync = /*#__PURE__*/ async <T, E>(
  thunks: ReadonlyArray<(signal?: AbortSignal) => AsyncResult<T, E>>,
  opts?: SignalOptions
): Promise<Result<Array<T>, E>> => {
  if (opts?.signal?.aborted) throw toPanic(opts.signal.reason ?? "aborted")
  const settled = await Promise.all(thunks.map((thunk) => callAsync(() => thunk(opts?.signal))))
  const values: Array<T> = []
  for (const r of settled) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
}

export interface MapConcurrentOptions {
  /** Maximum concurrently in-flight mapper invocations; non-finite values fall back to 1. */
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface MapConcurrent {
  <T, U, E>(
    inputs: ReadonlyArray<T>,
    mapper: (input: T, index: number, signal?: AbortSignal) => AsyncResult<U, E>,
    opts: MapConcurrentOptions
  ): AsyncResult<Array<U>, E>
}

/**
 * Map `mapper` over `inputs` with at most `opts.limit` in flight; select the first `Err` in
 * INPUT order. Runs to completion (an early `Err` does not abort in-flight work) — documented
 * choice for v1. `opts.signal` is forwarded to the mapper (3rd arg); aborting before a launch
 * is a defect (`Panic(abort reason)`).
 */
export const mapConcurrent: MapConcurrent = /*#__PURE__*/ async <T, U, E>(
  inputs: ReadonlyArray<T>,
  mapper: (input: T, index: number, signal?: AbortSignal) => AsyncResult<U, E>,
  opts: MapConcurrentOptions
): Promise<Result<Array<U>, E>> => {
  const floored = Math.floor(opts.limit)
  const limit = Number.isFinite(floored) ? Math.max(1, floored) : 1
  const results: Array<Result<U, E>> = new Array(inputs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      if (opts.signal?.aborted) throw toPanic(opts.signal.reason ?? "aborted")
      const index = next++
      results[index] = await callAsync(() => mapper(inputs[index]!, index, opts.signal))
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
  <T, E>(fn: (signal?: AbortSignal) => AsyncResult<T, E>, opts: RetryOptions<E>): AsyncResult<T, E>
}

/**
 * Retry on `Err` VALUES only — a defect (`Panic`) propagates immediately, never retried.
 * `opts.signal` is forwarded to `fn`; `delay: "exponential"` = 250ms * 2^attempt.
 * Abort semantics: see `RetryOptions.signal`.
 */
export const retry: Retry = /*#__PURE__*/ async <T, E>(
  fn: (signal?: AbortSignal) => AsyncResult<T, E>,
  opts: RetryOptions<E>
): Promise<Result<T, E>> => {
  // Defects (any throw or rejection) are wrapped as Panic and NEVER retried; an existing Panic
  // passes through untouched (no double-wrap). The wrapper throws through the loop, out of `retry`.
  const attempt = (): Promise<Result<T, E>> => callAsync(() => fn(opts.signal))
  // Abort before anything settled: there is no last Err to return, so this is a defect.
  if (opts.signal?.aborted) throw toPanic(opts.signal.reason ?? "aborted")
  let result = await attempt()
  for (let attemptNo = 0; !result.ok && attemptNo < opts.times; attemptNo++) {
    if (opts.while && !call(opts.while, result.error)) break
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
    try {
      result = await attempt()
    } catch (defect) {
      // A signal-honouring fn rejects when aborted mid-attempt: that is the abort, not a new
      // defect, so the last Err (the domain error that got us here) wins, per the module doc.
      if (opts.signal?.aborted) return result
      throw defect
    }
  }
  return result
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(toPanic(signal?.reason ?? "aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })

export interface TimeoutOptions {
  readonly signal?: AbortSignal
}

export interface Timeout {
  <T, E>(
    thunk: (signal?: AbortSignal) => AsyncResult<T, E>,
    ms: number,
    opts?: TimeoutOptions
  ): AsyncResult<T, E | TimeoutError>
}

/**
 * Bound a thunk by `ms` via `AbortSignal.timeout`, composed with an optional user signal via
 * `AbortSignal.any`. The COMBINED signal is forwarded into the thunk so underlying work can
 * observe cancellation. Timing out yields `Err(Timeout({ ms }))`; a USER signal abort is a
 * defect (`Panic(abort reason)`), and an already-aborted one short-circuits without running the
 * thunk; an invalid `ms` is a `Panic`; thunk defects propagate as `Panic`.
 */
export const timeout: Timeout = /*#__PURE__*/ async <T, E>(
  thunk: (signal?: AbortSignal) => AsyncResult<T, E>,
  ms: number,
  opts?: TimeoutOptions
): Promise<Result<T, E | TimeoutError>> => {
  const signal = opts?.signal
  // Already aborted: short-circuit like allAsync/retry, never running the thunk.
  if (signal?.aborted) throw toPanic(signal.reason ?? "aborted")
  // An invalid `ms` (negative, NaN, non-integer overflow) is a caller bug: the platform's own
  // RangeError/TypeError becomes the Panic's cause.
  const timeoutSignal = call((delay: number) => AbortSignal.timeout(delay), ms)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let settled = false
  const abortPromise = new Promise<never>((_, reject) => {
    combined.addEventListener(
      "abort",
      () => {
        if (!settled) reject(toPanic(combined.reason ?? "aborted"))
      },
      { once: true }
    )
  })
  abortPromise.catch(() => {}) // never an unhandled rejection when the thunk wins the race
  try {
    const result = await Promise.race([Promise.resolve(thunk(combined)), abortPromise])
    settled = true
    return result
  } catch (cause) {
    settled = true
    if (timeoutSignal.aborted && !signal?.aborted) return err(Timeout({ ms }))
    throw toPanic(cause)
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
    if (mapped === undefined) throw toPanic(cause)
    return err(mapped)
  }
}
