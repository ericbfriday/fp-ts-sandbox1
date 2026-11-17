/**
 * `@friday-friday/query` runtime tests, including a REAL query run through query-core's
 * QueryClient (proving `query.error` becomes exactly the tagged error and retry works).
 */
import { err, ok, type Result, taggedError } from "@friday-friday/core"
import { resultQueryOptions, retryUnless, toQueryFn } from "@friday-friday/query"
import { QueryClient, type QueryKey } from "@tanstack/query-core"
import { describe, expect, it } from "vitest"

const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundT = ReturnType<typeof NotFound>

describe("toQueryFn", () => {
  const signal = new AbortController().signal

  it("returns the value on Ok", async () => {
    const qf = toQueryFn<number, NotFoundT>(() => Promise.resolve(ok(42)))
    await expect(qf({ signal })).resolves.toBe(42)
  })

  it("throws the plain tagged error on Err (query.error === E)", async () => {
    const qf = toQueryFn<number, NotFoundT>(() => Promise.resolve(err(NotFound({ id: "1" }))))
    let caught: unknown
    try {
      await qf({ signal })
    } catch (e) {
      caught = e
    }
    expect(caught).toEqual(NotFound({ id: "1" }))
    expect(NotFound.is(caught)).toBe(true)
  })

  it("normalizes Ok(undefined) to null", async () => {
    const qf = toQueryFn<string | undefined, NotFoundT>(() => Promise.resolve(ok(undefined)))
    await expect(qf({ signal })).resolves.toBeNull()
  })

  it("forwards the context signal to the fetcher", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const qf = toQueryFn<number, never>((sig) => {
      seen = sig
      return Promise.resolve(ok(1))
    })
    await qf({ signal: controller.signal })
    expect(seen).toBe(controller.signal)
  })
})

describe("retryUnless", () => {
  const isNotFound = (e: string): boolean => e === "not-found"

  it("retries while the error is not excluded and budget remains", () => {
    const retry = retryUnless<string>(isNotFound, 3)
    expect(retry(0, "not-found")).toBe(false) // excluded -> stop
    expect(retry(0, "boom")).toBe(true)
    expect(retry(2, "boom")).toBe(true)
    expect(retry(3, "boom")).toBe(false) // budget exhausted
  })

  it("default max is 3", () => {
    const retry = retryUnless<string>(() => false)
    expect(retry(2, "e")).toBe(true)
    expect(retry(3, "e")).toBe(false)
  })
})

describe("resultQueryOptions + real query-core run", () => {
  it("fetchQuery resolves the value on Ok", async () => {
    const client = new QueryClient()
    const opts = resultQueryOptions<number, NotFoundT>({
      queryKey: ["user", "1"],
      queryFn: () => Promise.resolve(ok(7))
    })
    await expect(client.fetchQuery({ ...opts, queryKey: opts.queryKey })).resolves.toBe(7)
  })

  it("surfaces the tagged error as query.error on Err", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const opts = resultQueryOptions<number, NotFoundT>({
      queryKey: ["user", "missing"],
      queryFn: () => Promise.resolve(err(NotFound({ id: "404" })))
    })
    await expect(
      client.fetchQuery({ ...opts, queryKey: opts.queryKey, retry: false })
    ).rejects.toEqual(NotFound({ id: "404" }))
  })

  it("retryUnless integrates with query-core retries then surfaces the last error", async () => {
    let calls = 0
    const client = new QueryClient()
    const fetcher = (): Promise<Result<string, string>> => {
      calls++
      return Promise.resolve(err(`fail-${calls}`))
    }
    await expect(
      client.fetchQuery({
        queryKey: ["retried"] as QueryKey,
        // A queryFn must THROW on Err - toQueryFn is exactly that bridge:
        queryFn: toQueryFn(fetcher),
        retry: retryUnless<string>(() => false, 2)
      })
    ).rejects.toEqual("fail-3") // 1 initial + 2 retries
    expect(calls).toBe(3)
  })
})
