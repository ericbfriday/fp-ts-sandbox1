/**
 * `@friday-friday/query` type tests — `resultQueryOptions` is generic over TanStack's own
 * `QueryObserverOptions`, so readonly (`as const`) keys and every other option pass through,
 * and the returned key carries TanStack's `DataTag` (Design Report §5.4).
 */
import { ok, type Result, taggedError } from "@friday-friday/core"
import { resultQueryOptions, retryUnless } from "@friday-friday/query"
import { QueryClient } from "@tanstack/query-core"
import { describe, expectTypeOf, it } from "vitest"

const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundE = ReturnType<typeof NotFound>

const fetchUser = (_signal: AbortSignal): Promise<Result<{ id: string }, NotFoundE>> => Promise.resolve(ok({ id: "1" }))

describe("resultQueryOptions", () => {
  it("accepts an `as const` query key and keeps it literal", () => {
    const opts = resultQueryOptions({ queryKey: ["user", 1] as const, queryFn: fetchUser })
    expectTypeOf(opts.queryKey).toExtend<readonly ["user", 1]>()
  })

  it("tags the key so the QueryClient infers data and error from it", () => {
    const client = new QueryClient()
    const opts = resultQueryOptions({ queryKey: ["user", 1] as const, queryFn: fetchUser })
    expectTypeOf(client.getQueryData(opts.queryKey)).toEqualTypeOf<{ id: string } | undefined>()
    expectTypeOf(client.getQueryState(opts.queryKey)?.error).toEqualTypeOf<NotFoundE | null | undefined>()
  })

  it("Ok(undefined) is typed as null data", () => {
    const opts = resultQueryOptions({
      queryKey: ["maybe"],
      queryFn: (): Promise<Result<undefined, NotFoundE>> => Promise.resolve(ok(undefined))
    })
    expectTypeOf(new QueryClient().fetchQuery(opts)).resolves.toEqualTypeOf<null>()
  })

  it("passes TanStack's other options through, typed against E", () => {
    const opts = resultQueryOptions({
      queryKey: ["user", 1] as const,
      queryFn: fetchUser,
      staleTime: 30_000,
      enabled: true,
      meta: { feature: "profile" },
      retryDelay: (_attempt, error) => (NotFound.is(error) ? 0 : 1000),
      retry: retryUnless<NotFoundE>((e) => NotFound.is(e)),
      throwOnError: (error) => error._tag === "NotFound"
    })
    expectTypeOf(opts.retry).toEqualTypeOf<
      boolean | number | ((failureCount: number, error: NotFoundE) => boolean) | undefined
    >()
    // `retry` keeps TanStack's full RetryValue: booleans and counts are accepted too.
    resultQueryOptions({ queryKey: ["user"], queryFn: fetchUser, retry: false })
    resultQueryOptions({ queryKey: ["user"], queryFn: fetchUser, retry: 2 })
  })

  it("select narrows the observer's data type", () => {
    const opts = resultQueryOptions({
      queryKey: ["user", 1] as const,
      queryFn: fetchUser,
      select: (user) => user.id
    })
    const selected = opts.select?.({ id: "1" })
    expectTypeOf(selected).toEqualTypeOf<string | undefined>()
  })

  it("is spread-compatible with fetchQuery and ensureQueryData", () => {
    const client = new QueryClient()
    const opts = resultQueryOptions({ queryKey: ["user", 1] as const, queryFn: fetchUser })
    expectTypeOf(client.fetchQuery(opts)).resolves.toEqualTypeOf<{ id: string }>()
    expectTypeOf(client.ensureQueryData(opts)).resolves.toEqualTypeOf<{ id: string }>()
  })

  it("rejects a retry predicate typed against a different error", () => {
    resultQueryOptions({
      queryKey: ["user"],
      queryFn: fetchUser,
      // @ts-expect-error - the predicate's error must accept E (NotFoundE), not number
      retry: (_n: number, e: number) => e > 0
    })
  })
})
