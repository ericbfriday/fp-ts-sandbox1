/**
 * `@friday-friday/query` — TanStack Query adapter (Design Report §5.4).
 *
 * Why throw the plain error object: TanStack's contract is "the query function must throw or
 * return a rejected Promise" — an `Err` returned inside `data` would never trigger retry or
 * error boundaries. Throwing the tagged error makes `query.error` exactly `E`, so retry
 * predicates and `throwOnError` work on tags. `Ok(undefined)` becomes `null` because "queries
 * that resolve to undefined will be treated as failed" (query docs). The context `signal` is
 * forwarded so in-flight queries actually cancel.
 */

import type { Result } from "@friday-friday/core"

/** Minimal structural view of TanStack's QueryFunctionContext (keeps this package core-only). */
export interface QueryContext {
  readonly signal: AbortSignal
}

/** TanStack queryFn return: Ok(undefined) is normalized to null (undefined counts as failed). */
type QueryFnReturn<T> = T extends undefined ? null : T

export interface ToQueryFn {
  /**
   * Adapt an AsyncResult-producing fetcher into a TanStack queryFn:
   * `Err(e)` -> throws `e` (plain tagged error, so `query.error` is exactly `E`);
   * `Ok(undefined)` -> resolves `null` (undefined counts as a failed query);
   * the context signal is forwarded to the fetcher.
   */
  <T, E>(
    fn: (signal: AbortSignal) => Promise<Result<T, E>>
  ): (ctx: QueryContext) => Promise<QueryFnReturn<T>>
}

// The concrete implementation cannot satisfy the conditional-return signature generically
// (TS 7.1-beta rejects `Promise<T extends undefined ? null : T>` against `Promise<T>` where
// 7.0/6.0 accepted it) — same idiom as `All`'s documented assertion.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberate concrete-impl idiom, see comment above
export const toQueryFn: ToQueryFn =
  /*#__PURE__*/ ((fn: (signal: AbortSignal) => Promise<Result<unknown, unknown>>) =>
  async (ctx: QueryContext): Promise<unknown> => {
    const r = await fn(ctx.signal)
    if (!r.ok) throw r.error
    // Ok(undefined) is TanStack's "failed query" sentinel — normalize to null.
    return r.value === undefined ? null : r.value
  }) as ToQueryFn
// (the assertion is the deliberate concrete-impl idiom; see comment above)

export interface RetryUnless {
  /**
   * TanStack `retry` predicate factory: keep retrying while the error is NOT in `stop`'s
   * exclusion set and the retry budget (max, default 3) is not exhausted. Defect-shaped
   * errors (no `_tag`) are retryable by default — callers decide via `stop`.
   */
  <E>(stop: (e: E) => boolean, max?: number): (failureCount: number, error: E) => boolean
}

export const retryUnless: RetryUnless =
  <E>(stop: (e: E) => boolean, max = 3) => (failureCount: number, error: E): boolean =>
    !stop(error) && failureCount < max

export interface ResultQueryOptionsInput<T, E> {
  /** TanStack query key. */
  readonly queryKey: Array<unknown>
  /** The Result fetcher; receives the query context signal. */
  readonly queryFn: (signal: AbortSignal) => Promise<Result<T, E>>
  /** Optional TanStack retry predicate composed from the error channel. */
  readonly retry?: (failureCount: number, error: E) => boolean
}

export interface ResultQueryOptions<T, E> {
  readonly queryKey: Array<unknown>
  readonly queryFn: (ctx: QueryContext) => Promise<QueryFnReturn<T>>
  readonly retry?: (failureCount: number, error: E) => boolean
}

/**
 * Assemble query options from a Result fetcher: the queryFn throws the plain tagged error on
 * `Err` (so `query.error` is exactly `E`) and normalizes `Ok(undefined)` to `null`. The returned
 * object is spread-compatible with TanStack's `useQuery` / `queryOptions` helpers.
 */
export function resultQueryOptions<T, E>(o: ResultQueryOptionsInput<T, E>): ResultQueryOptions<T, E> {
  const queryFn = (ctx: QueryContext): Promise<T extends undefined ? null : T> => toQueryFn(o.queryFn)(ctx)
  if (o.retry === undefined) {
    return { queryKey: o.queryKey, queryFn }
  }
  return { queryKey: o.queryKey, queryFn, retry: o.retry }
}
