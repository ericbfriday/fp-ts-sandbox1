/**
 * `@friday-friday/query` type tests against the REAL `@tanstack/react-query` hooks (#58).
 * `resultQueryOptions` must accept `queryFn: skipToken` exactly where TanStack's own
 * `queryOptions` does (conditional queries), and must not leak `SkipToken` into options built
 * without it, or `useSuspenseQuery` (which rejects `skipToken`) would stop compiling.
 */
import { type NotFound, ok, type Result } from "@friday-friday/core"
import { resultQueryOptions } from "@friday-friday/query"
import { skipToken, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { describe, expectTypeOf, it } from "vitest"

type NotFoundE = ReturnType<typeof NotFound>

const fetchUser = (_signal: AbortSignal): Promise<Result<{ id: string }, NotFoundE>> => Promise.resolve(ok({ id: "1" }))
declare const userId: string | undefined

describe("resultQueryOptions + skipToken (real useQuery)", () => {
  it("accepts queryFn: skipToken on its own", () => {
    const opts = resultQueryOptions({ queryKey: ["user"], queryFn: skipToken })
    expectTypeOf(useQuery(opts).data).toEqualTypeOf<unknown>()
  })

  it("accepts a conditional fetcher-or-skipToken and still infers data and E", () => {
    const opts = resultQueryOptions({ queryKey: ["user", userId] as const, queryFn: userId ? fetchUser : skipToken })
    expectTypeOf(useQuery(opts).data).toEqualTypeOf<{ id: string } | undefined>()
    expectTypeOf(useQuery(opts).error).toEqualTypeOf<NotFoundE | null>()
  })

  it("keeps useSuspenseQuery working when skipToken is not used", () => {
    const opts = resultQueryOptions({ queryKey: ["user"], queryFn: fetchUser })
    expectTypeOf(useSuspenseQuery(opts).data).toEqualTypeOf<{ id: string }>()
  })

  it("rejects skipToken options in useSuspenseQuery, as TanStack does", () => {
    const opts = resultQueryOptions({ queryKey: ["user"], queryFn: userId ? fetchUser : skipToken })
    // @ts-expect-error - Suspense hooks cannot render a disabled query, so skipToken is refused
    useSuspenseQuery(opts)
  })
})
