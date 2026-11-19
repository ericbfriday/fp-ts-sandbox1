/**
 * `/async` type tests (RFC-0001 §4).
 */
import { type AsyncResult, err, ok, pipe, taggedError, Timeout } from "@friday-friday/core"
import { andThenAsync, mapAsync, mapConcurrent, retry, timeout, tryAsync } from "@friday-friday/core/async"
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
    const attempt = (): AsyncResult<number, "nf"> => Promise.resolve(err("nf"))
    expectTypeOf(retry(attempt, { times: 3 })).toEqualTypeOf<AsyncResult<number, "nf">>()
  })

  test("timeout unions E with Timeout", () => {
    const attempt = (): AsyncResult<number, "nf"> => Promise.resolve(err("nf"))
    expectTypeOf(timeout(attempt, 100)).toEqualTypeOf<AsyncResult<number, "nf" | Timeout>>()
  })

  test("mapConcurrent returns the values array", () => {
    const toLabel = (n: number): AsyncResult<string, "nf"> => Promise.resolve(n > 0 ? ok(String(n)) : err("nf"))
    expectTypeOf(mapConcurrent([1, 2], toLabel, { limit: 2 })).toEqualTypeOf<AsyncResult<Array<string>, "nf">>()
  })

  test("tryAsync maps the catch handler's error type", () => {
    const NotFound = taggedError("NotFound")<{ readonly id?: string }>()
    const r = tryAsync(
      async () => 1,
      { catch: () => NotFound({ id: "1" }) }
    )
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, ReturnType<typeof NotFound>>>()
  })

  test("Timeout is a value + type twin: both name the error (RFC-0001 §2)", () => {
    expectTypeOf(Timeout({ ms: 1 })).toEqualTypeOf<Timeout>()
    expectTypeOf<Timeout["_tag"]>().toEqualTypeOf<"Timeout">()
    // ADR-0005: every prop on a fixed tag is optional, `Timeout`'s `ms` included (#87).
    expectTypeOf<Timeout["ms"]>().toEqualTypeOf<number | undefined>()
  })
})
