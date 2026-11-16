/**
 * `/async` type tests (RFC-0001 §4).
 */
import { type AsyncResult, err, ok, pipe, taggedError } from "@friday-friday/core"
import {
  andThenAsync,
  mapAsync,
  mapConcurrent,
  retry,
  timeout,
  type TimeoutError,
  tryAsync
} from "@friday-friday/core/async"
import { describe, expectTypeOf, test } from "vitest"

describe("async types", () => {
  test("mapAsync returns AsyncResult and accepts Results or Promises", () => {
    expectTypeOf(mapAsync(ok(1), async (n: number) => n + 1)).toEqualTypeOf<AsyncResult<number, never>>()
    expectTypeOf(pipe(Promise.resolve(ok(1)), mapAsync(String))).toEqualTypeOf<AsyncResult<string, never>>()
    expectTypeOf(pipe(err("e"), mapAsync(String))).toEqualTypeOf<AsyncResult<string, string>>()
  })

  test("andThenAsync widens E through |", () => {
    const step = (n: number): AsyncResult<number, "nf"> => Promise.resolve(n > 0 ? ok(n) : err("nf"))
    const step2 = (n: number): AsyncResult<number, "fb"> => Promise.resolve(n > 1 ? ok(n) : err("fb"))
    const r = pipe(Promise.resolve(ok(1)), andThenAsync(step), andThenAsync(step2))
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, "nf" | "fb">>()
  })

  test("retry keeps the domain error type", () => {
    const r: AsyncResult<number, "nf"> = retry(async () => err("nf"), { times: 3 })
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, "nf">>()
  })

  test("timeout unions E with TimeoutError", () => {
    const r: AsyncResult<number, "nf" | TimeoutError> = timeout(async () => err("nf"), 100)
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, "nf" | TimeoutError>>()
  })

  test("mapConcurrent returns the values array", () => {
    const r: AsyncResult<Array<string>, "nf"> = mapConcurrent(
      [1, 2],
      async (n: number) => ok(String(n)),
      { limit: 2 }
    )
    expectTypeOf(r).toEqualTypeOf<AsyncResult<Array<string>, "nf">>()
  })

  test("tryAsync maps the catch handler's error type", () => {
    const NotFound = taggedError("NotFound")<{ id: string }>()
    const r = tryAsync(
      async () => 1,
      { catch: () => NotFound({ id: "1" }) }
    )
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, ReturnType<typeof NotFound>>>()
  })
})
