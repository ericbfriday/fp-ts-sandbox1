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
import type { DataTag, QueryFunction, QueryKey, QueryObserverOptions } from "@tanstack/query-core"

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
export const toQueryFn: ToQueryFn =
  // oxlint-disable-next-line no-unsafe-type-assertion -- deliberate concrete-impl idiom
  /*#__PURE__*/ ((fn: (signal: AbortSignal) => Promise<Result<unknown, unknown>>) =>
  async (ctx: QueryContext): Promise<unknown> => {
    const r = await fn(ctx.signal)
    if (!r.ok) throw r.error
    // Ok(undefined) is TanStack's "failed query" sentinel — normalize to null.
    return r.value === undefined ? null : r.value
  }) as ToQueryFn
// (the assertion above is the deliberate concrete-impl idiom; see comment above)

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

/**
 * Input to {@link resultQueryOptions}: TanStack's own `QueryObserverOptions` (so readonly keys,
 * `staleTime`, `enabled`, `select`, `meta`, `throwOnError`, a numeric or boolean `retry` and the
 * rest pass through unchanged), with `queryFn` replaced by a Result fetcher. `E` is inferred from
 * the fetcher only, so a mistyped `retry` / `throwOnError` is reported where it is written.
 */
export interface ResultQueryOptionsInput<T, E, TData = QueryFnReturn<T>, K extends QueryKey = QueryKey> extends
  Omit<
    QueryObserverOptions<QueryFnReturn<T>, NoInfer<E>, TData, QueryFnReturn<T>, K>,
    "queryFn"
  >
{
  /** The Result fetcher; receives the query context signal. */
  readonly queryFn: (signal: AbortSignal) => Promise<Result<T, E>>
}

/**
 * Options returned by {@link resultQueryOptions}: TanStack's `QueryObserverOptions` with a
 * throwing `queryFn`, and the key tagged with `DataTag` (as `queryOptions` from the framework
 * packages does) so `queryClient.getQueryData(opts.queryKey)` infers data and error.
 */
export interface ResultQueryOptions<T, E, TData = QueryFnReturn<T>, K extends QueryKey = QueryKey>
  extends Omit<QueryObserverOptions<QueryFnReturn<T>, E, TData, QueryFnReturn<T>, K>, "queryFn" | "queryKey">
{
  readonly queryKey: DataTag<K, QueryFnReturn<T>, E>
  readonly queryFn: QueryFunction<QueryFnReturn<T>, K>
}

/**
 * Build TanStack query options from a Result fetcher (Design Report §5.4). The `queryFn` throws
 * the plain tagged error on `Err` (so `query.error` is exactly `E`) and normalizes `Ok(undefined)`
 * to `null`; every other option is passed through untouched. The result spreads into `useQuery`,
 * `queryOptions`, `fetchQuery`, `prefetchQuery` and `ensureQueryData`.
 */
export function resultQueryOptions<T, E, TData = QueryFnReturn<T>, K extends QueryKey = QueryKey>(
  o: ResultQueryOptionsInput<T, E, TData, K>
): ResultQueryOptions<T, E, TData, K> {
  const { queryFn, ...rest } = o
  const options: unknown = { ...rest, queryFn: toQueryFn(queryFn) }
  // DataTag is a phantom brand on the key (no runtime field), so an assertion is the only way to
  // attach it; TanStack's own `queryOptions` likewise returns its input with a re-typed key.
  // oxlint-disable-next-line no-unsafe-type-assertion -- phantom DataTag brand on queryKey
  return options as ResultQueryOptions<T, E, TData, K>
}
