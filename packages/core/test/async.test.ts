/**
 * `/async` subpath tests (RFC-0001 §4 + Design Report §3.6).
 *
 * NOTE on data-first forms: the TS 7.0.2 root-tsc inference quirk documented in result.test.ts
 * applies here too — tests use `pipe` / data-first sparingly and prefer data-last forms.
 */
import { andThen, type AsyncResult, err, ok, Panic, pipe, type Result, trySync } from "@friday-friday/core"
import {
  allAsync,
  andThenAsync,
  mapAsync,
  mapConcurrent,
  orElseAsync,
  retry,
  tapAsync,
  tapErrAsync,
  Timeout,
  timeout,
  tryAsync
} from "@friday-friday/core/async"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { jsonValue } from "./_fixtures.js"

const roundTrips = (x: unknown): void => {
  expect(JSON.parse(JSON.stringify(x))).toStrictEqual(x)
  expect(structuredClone(x)).toStrictEqual(x)
}

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const slowOk = async (ms: number, value: number): Promise<Result<number, string>> => {
  await new Promise((r) => setTimeout(r, ms))
  return ok(value)
}

describe("async-aware duals", () => {
  it("mapAsync awaits the input and the callback (both branches)", async () => {
    expect(await pipe(ok(1), mapAsync(async (n) => n + 1))).toEqual(ok(2))
    expect(await pipe(Promise.resolve(err("bad")), mapAsync(() => 42))).toEqual(err("bad"))
  })

  it("andThenAsync chains AsyncResults and widens E", async () => {
    const step = (n: number): AsyncResult<number, "nf"> => (n > 0 ? Promise.resolve(ok(n)) : Promise.resolve(err("nf")))
    expect(await pipe(Promise.resolve(ok(1)), andThenAsync(step))).toEqual(ok(1))
    expect(await pipe(Promise.resolve(ok(0)), andThenAsync(step))).toEqual(err("nf"))
    // Err short-circuits: the second andThenAsync never runs on err('nf')
    const r: Result<number, "nf" | "fb"> = await pipe(
      Promise.resolve(ok(0)),
      andThenAsync(step),
      andThenAsync((): AsyncResult<number, "fb"> => Promise.resolve(err("fb")))
    )
    expect(r).toEqual(err("nf"))
    // ...but runs after a successful first step, widening E
    const r2: Result<number, "nf" | "fb"> = await pipe(
      Promise.resolve(ok(1)),
      andThenAsync(step),
      andThenAsync((): AsyncResult<number, "fb"> => Promise.resolve(err("fb")))
    )
    expect(r2).toEqual(err("fb"))
  })

  it("orElseAsync recovers from Err only", async () => {
    expect(await pipe(Promise.resolve(err("a")), orElseAsync(() => Promise.resolve(ok(9))))).toEqual(ok(9))
    expect(await pipe(Promise.resolve(ok(1)), orElseAsync(() => Promise.resolve(ok(9))))).toEqual(ok(1))
  })

  it("tapAsync / tapErrAsync observe without changing the Result", async () => {
    const seen: Array<string> = []
    expect(
      await pipe(
        Promise.resolve(ok(1)),
        tapAsync((n) => {
          seen.push(`ok:${n}`)
        })
      )
    ).toEqual(ok(1))
    expect(
      await pipe(
        Promise.resolve(err("e")),
        tapErrAsync((e) => {
          seen.push(`err:${e}`)
        })
      )
    ).toEqual(err("e"))
    expect(seen).toEqual(["ok:1", "err:e"])
  })

  it("outputs are plain data across helpers (JSON + structuredClone)", async () => {
    await fc.assert(
      fc.asyncProperty(jsonValue, jsonValue, async (v, e) => {
        roundTrips(await andThenAsync(Promise.resolve(ok(v)), async () => ok(e)))
        roundTrips(
          await allAsync([
            async (): AsyncResult<unknown> => ok(v),
            async (): AsyncResult<unknown> => ok(e)
          ])
        )
        roundTrips(await mapConcurrent([v], async (x) => ok(x), { limit: 1 }))
        roundTrips(await retry(async () => ok(v), { times: 2 }))
      })
    )
  })

  it("accepts bare Results as inputs", async () => {
    expect(await mapAsync(ok(1), (n) => n * 2)).toEqual(ok(2))
  })

  it("outputs are plain data (JSON + structuredClone)", async () => {
    await fc.assert(
      fc.asyncProperty(jsonValue, async (v) => {
        roundTrips(await mapAsync(Promise.resolve(ok(v)), async (x) => x))
        roundTrips(await tryAsync(async () => v, { catch: () => "mapped" }))
      })
    )
  })
})

describe("allAsync", () => {
  it("runs thunks concurrently and returns values in input order", async () => {
    const order: Array<string> = []
    const r = await allAsync([
      async () => {
        await new Promise((res) => setTimeout(res, 20))
        order.push("first-slowest")
        return ok(1)
      },
      async () => {
        order.push("second-fast")
        return ok(2)
      }
    ])
    expect(r).toEqual(ok([1, 2]))
    expect(order).toEqual(["second-fast", "first-slowest"]) // concurrent, not sequential
  })

  it("selects the first Err in INPUT order even when a later Err settles first", async () => {
    const late = deferred<Result<number, string>>()
    const early = deferred<Result<number, string>>()
    const promise = allAsync([() => late.promise, () => early.promise])
    early.resolve(err("early"))
    late.resolve(err("late"))
    expect(await promise).toEqual(err("late"))
  })

  it("keeps the first input-order Err among mixed Ok/Err", async () => {
    const r = await allAsync([
      async () => ok(1),
      async () => err("second-err"),
      async () => err("third-err")
    ])
    expect(r).toEqual(err("second-err"))
  })
})

describe("mapConcurrent", () => {
  it("respects the concurrency limit", async () => {
    let inFlight = 0
    let peak = 0
    const r = await mapConcurrent(
      [1, 2, 3, 4, 5, 6],
      async (n) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((res) => setTimeout(res, 5))
        inFlight--
        return ok(n * 2)
      },
      { limit: 2 }
    )
    expect(r).toEqual(ok([2, 4, 6, 8, 10, 12]))
    expect(peak).toBe(2)
  })

  it("selects the first Err in input order", async () => {
    const r = await mapConcurrent(
      [1, 2, 3],
      async (n) => (n === 1 ? err<string>("one") : ok<number>(n)),
      { limit: 3 }
    )
    expect(r).toEqual(err("one"))
  })

  it("forwards opts.signal to the mapper and abort-before-launch is a defect", async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    let panicked = false
    const promise = mapConcurrent(
      [1, 2, 3],
      (n, _i, signal) => {
        seen.push(signal)
        if (n === 1) controller.abort() // abort while later launches are pending
        return new Promise<Result<number, string>>((resolve) => setTimeout(() => resolve(ok(n)), 5))
      },
      { limit: 1, signal: controller.signal }
    ).catch((e: unknown) => {
      panicked = e instanceof Panic
      return err("aborted") as Result<Array<number>, string>
    })
    await promise
    expect(seen.every((s) => s === controller.signal)).toBe(true)
    expect(panicked).toBe(true)
  })

  it("an already-aborted signal is a Panic up front, like allAsync, even for empty inputs", async () => {
    await expect(mapConcurrent([], async () => ok(1), { limit: 1, signal: AbortSignal.abort() })).rejects.toThrow(
      Panic
    )
    await expect(allAsync([], { signal: AbortSignal.abort() })).rejects.toThrow(Panic)
  })

  it("non-finite limit falls back to 1", async () => {
    const r = await mapConcurrent([1, 2], async (n) => ok(n), { limit: Number.NaN })
    expect(r).toEqual(ok([1, 2]))
  })
})

describe("retry", () => {
  it("does not retry on Ok", async () => {
    let calls = 0
    const r = await retry(async () => {
      calls++
      return ok(calls)
    }, { times: 5 })
    expect(r).toEqual(ok(1))
    expect(calls).toBe(1)
  })

  it("retries on Err up to times, then returns the last Err", async () => {
    let calls = 0
    const r = await retry(async () => {
      calls++
      return err(`fail-${calls}`)
    }, { times: 3, delay: 1 })
    expect(r).toEqual(err("fail-4")) // 1 initial + 3 retries
    expect(calls).toBe(4)
  })

  it("stops early when while says the error is not retryable", async () => {
    let calls = 0
    const r = await retry(
      async () => {
        calls++
        return err<string>("fatal")
      },
      { times: 5, delay: 1, while: (e) => e !== "fatal" }
    )
    expect(r).toEqual(err("fatal"))
    expect(calls).toBe(1)
  })

  it("never retries a defect (Panic propagates immediately)", async () => {
    let calls = 0
    await expect(
      retry(async () => {
        calls++
        throw "defect"
      }, { times: 5, delay: 1 })
    ).rejects.toThrow(Panic)
    expect(calls).toBe(1)
  })

  it("exponential backoff grows 250 * 2^attempt", async () => {
    const gaps: Array<number> = []
    let last = Date.now()
    const r = await retry(
      async () => {
        const now = Date.now()
        gaps.push(now - last)
        last = now
        return err("x")
      },
      { times: 2, delay: "exponential" }
    )
    expect(r).toEqual(err("x"))
    expect(gaps[1]).toBeGreaterThanOrEqual(240)
    expect(gaps[2]).toBeGreaterThanOrEqual(480)
  })

  it("abort mid-retry returns the LAST Err (documented choice)", async () => {
    const controller = new AbortController()
    let calls = 0
    const r = await retry(
      async () => {
        calls++
        if (calls === 2) controller.abort()
        return err<string>(`fail-${calls}`)
      },
      { times: 10, delay: 20, signal: controller.signal }
    )
    expect(r).toEqual(err("fail-2"))
    expect(calls).toBe(2)
  })

  it("forwards opts.signal to fn", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    await retry(
      async (signal?: AbortSignal) => {
        seen = signal
        return ok(1)
      },
      { times: 1, signal: controller.signal }
    )
    expect(seen).toBe(controller.signal)
  })

  it("abort mid-ATTEMPT (signal-honouring fn) returns the last Err, not a Panic", async () => {
    const controller = new AbortController()
    let calls = 0
    const r = await retry(
      (signal?: AbortSignal) => {
        calls++
        if (calls === 1) return Promise.resolve(err<string>("first-err"))
        return new Promise<Result<number, string>>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          setTimeout(() => controller.abort(), 5)
        })
      },
      { times: 3, delay: 1, signal: controller.signal }
    )
    expect(r).toEqual(err("first-err"))
    expect(calls).toBe(2)
  })

  it("an UNRELATED throw after abort is still a defect: Panic(cause), not the last Err", async () => {
    const controller = new AbortController()
    const bug = new TypeError("real bug unrelated to abort")
    let calls = 0
    const promise = retry(
      async () => {
        calls++
        if (calls === 1) return err<string>("first")
        controller.abort()
        throw bug
      },
      { times: 3, signal: controller.signal }
    )
    await expect(promise).rejects.toThrow(Panic)
    await expect(promise).rejects.toMatchObject({ cause: bug })
  })

  it("a fn rejecting with an AbortError of its own (not signal.reason) on abort returns the last Err", async () => {
    const controller = new AbortController()
    let calls = 0
    const r = await retry(
      (signal?: AbortSignal) => {
        calls++
        if (calls === 1) return Promise.resolve(err<string>("first-err"))
        return new Promise<Result<number, string>>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("op aborted", "AbortError")), {
            once: true
          })
          controller.abort(new Error("caller gave up"))
        })
      },
      { times: 3, signal: controller.signal }
    )
    expect(r).toEqual(err("first-err"))
  })

  it("abort mid-FIRST-attempt has no last Err, so it is a defect (Panic)", async () => {
    const controller = new AbortController()
    const promise = retry(
      (signal?: AbortSignal) =>
        new Promise<Result<number, string>>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
      { times: 3, signal: controller.signal }
    )
    controller.abort()
    await expect(promise).rejects.toThrow(Panic)
  })

  it("abort before any result throws Panic", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      retry(async () => err<string>("x"), { times: 3, delay: 50, signal: controller.signal })
    ).rejects.toThrow(Panic)
  })
})

describe("timeout", () => {
  it("passes a fast thunk through unchanged", async () => {
    const r = await timeout(() => slowOk(5, 7), 500)
    expect(r).toEqual(ok(7))
  })

  it("yields Err(Timeout({ ms })) when the thunk exceeds the budget", async () => {
    const r = await timeout(() => slowOk(200, 1), 20)
    expect(r).toEqual(err(Timeout({ ms: 20 })))
    if (!r.ok && Timeout.is(r.error)) expect(r.error.ms).toBe(20)
    else expect.unreachable("expected Err(Timeout)")
  })

  it("combines the user signal: user abort is a defect, not a Timeout", async () => {
    const controller = new AbortController()
    const promise = timeout(() => slowOk(200, 1), 5000, { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow(Panic)
  })

  it("forwards the combined signal so underlying work can observe cancellation", async () => {
    let sawAbort = false
    const r = await timeout(
      (signal?: AbortSignal) =>
        new Promise<Result<number>>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true
              resolve(ok(0))
            },
            { once: true }
          )
        }),
      20
    )
    expect(r).toEqual(err(Timeout({ ms: 20 })))
    expect(sawAbort).toBe(true) // the work actually observed cancellation, not just the race
  })

  it("an already-aborted user signal short-circuits like allAsync/retry: Panic, thunk never runs", async () => {
    let ran = false
    const promise = timeout(
      async () => {
        ran = true
        return ok("ran")
      },
      1000,
      { signal: AbortSignal.abort("cancelled") }
    )
    await expect(promise).rejects.toThrow(Panic)
    await expect(promise).rejects.toMatchObject({ cause: "cancelled" })
    expect(ran).toBe(false)
  })

  it.each([-1, Number.NaN])("an invalid ms (%s) is a defect: Panic, thunk never runs", async (ms) => {
    let ran = false
    const promise = timeout(async () => {
      ran = true
      return ok("ran")
    }, ms)
    await expect(promise).rejects.toThrow(Panic)
    expect(ran).toBe(false)
  })
})

describe("tryAsync (boundary triage, RFC-0001 §3 async half)", () => {
  it("returns ok on success", async () => {
    expect(await tryAsync(async () => 42, { catch: () => "never" })).toEqual(ok(42))
  })

  it("maps a rejection to err via catch", async () => {
    const r = await tryAsync<number, string>(async () => {
      throw "boom"
    }, { catch: (c) => `mapped:${String(c)}` })
    expect(r).toEqual(err("mapped:boom"))
  })

  it("rethrow runs first so framework sentinels propagate untouched", async () => {
    const sentinel = new Error("sentinel: framework control flow")
    let caught: unknown
    try {
      await tryAsync(async () => {
        throw sentinel
      }, {
        rethrow: (c) => {
          if (c instanceof Error) throw c
        },
        catch: () => "mapped"
      })
    } catch (x) {
      caught = x
    }
    expect(caught).toBe(sentinel)
  })

  it("forwards the signal into fn", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    await tryAsync(async (signal) => {
      seen = signal
    }, { catch: () => "x", signal: controller.signal })
    expect(seen).toBe(controller.signal)
  })
})

describe("sync/async equivalence (RFC-0001 §4)", () => {
  it("mapAsync mirrors map, andThenAsync mirrors andThen", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), fc.integer(), async (n, m) => {
        const sync = pipe(ok(n), andThen((x) => (x > 0 ? ok(x + m) : err("neg"))))
        const asyncR = await pipe(Promise.resolve(ok(n)), andThenAsync(async (x) => (x > 0 ? ok(x + m) : err("neg"))))
        expect(asyncR).toEqual(sync)
      }),
      { numRuns: 25 }
    )
  })

  it("trySync and tryAsync agree on the mapped/unmapped contract", async () => {
    const thrower = (): number => {
      throw "boom"
    }
    const sync = trySync(thrower, { catch: (c) => `m:${String(c)}` })
    const asyncR = await tryAsync(async () => thrower(), { catch: (c) => `m:${String(c)}` })
    expect(asyncR).toEqual(sync)
  })
})

describe("Timeout tagged error (infrastructure taxonomy)", () => {
  it("has the Timeout tag and ms prop, structural across copies", () => {
    const t = Timeout({ ms: 30 })
    expect(t._tag).toBe("Timeout")
    expect(Timeout.is(t)).toBe(true)
    expect(Timeout.is(JSON.parse(JSON.stringify(t)))).toBe(true)
    roundTrips(t)
  })
})
