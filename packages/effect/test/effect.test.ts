/**
 * `@friday-friday/effect` runtime tests — real Effect 4.0.6 runtime (Effect.gen, Exit
 * constructors, runPromise).
 */
import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

/* oxlint-disable no-unsafe-type-assertion -- wire probes: Panic cause is structurally accessed */
import { err, ok, Panic, taggedError } from "@friday-friday/core"
import { fromExit, runResult, toEffect } from "@friday-friday/effect"

describe("fromExit", () => {
  it("Success -> Ok(value)", () => {
    expect(fromExit(Exit.succeed(42))).toEqual(ok(42))
  })

  it("Fail reason -> Err(E) with the original error object", () => {
    const exit = Exit.fail("not-found")
    expect(fromExit(exit)).toEqual(err("not-found"))
  })

  it("Fail with a tagged error -> Err(tagged)", () => {
    const UserNotFound = taggedError("UserNotFound")<{ id: string }>()
    const exit = Exit.fail(UserNotFound({ id: "u_1" }))
    const r = fromExit(exit)
    if (!r.ok) expect(r.error._tag).toBe("UserNotFound")
    else throw new Error("expected Err")
  })

  it("Die(Panic) -> the SAME Panic, never a Panic whose cause is a Panic (core toPanic)", () => {
    const panic = new Panic(new Error("boom"))
    let thrown: unknown
    try {
      fromExit(Exit.die(panic))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(panic)
  })

  it("Die -> thrown Panic(defect)", () => {
    const exit = Exit.die(new Error("boom"))
    expect(() => fromExit(exit)).toThrow(Panic)
    try {
      fromExit(exit)
    } catch (e) {
      expect((e as Panic).cause).toEqual(new Error("boom"))
    }
  })

  it("Interrupt -> thrown Panic", () => {
    const exit = Exit.interrupt(7)
    expect(() => fromExit(exit)).toThrow(Panic)
  })

  it("mixed Fail + Die -> Die wins (a bug anywhere means a bug), unlike Cause.squash", () => {
    const bug = new Error("primary bug")
    const cause = Cause.fromReasons([
      { _tag: "Fail", error: "secondary", annotations: new Map() },
      { _tag: "Die", defect: bug, annotations: new Map() }
    ] as never)
    expect(() => fromExit(Exit.failCause(cause))).toThrow(Panic)
    expect(() => fromExit(Exit.failCause(cause))).toThrow(expect.objectContaining({ cause: bug }))
    // Pins the divergence the bridge documents: Effect's own squash prefers the first Fail.
    expect(Cause.squash(cause)).toBe("secondary")
  })
})

describe("runResult", () => {
  it("successful effect -> Ok(value)", async () => {
    const eff = Effect.succeed(42)
    expect(await runResult(eff)).toEqual(ok(42))
  })

  it("failing effect -> Err(E) as data", async () => {
    const eff = Effect.fail("domain-error")
    const r = await runResult(eff)
    expect(r).toEqual(err("domain-error"))
  })

  it("dying effect -> thrown Panic", async () => {
    const eff = Effect.die(new Error("bug"))
    await expect(runResult(eff)).rejects.toThrow(Panic)
    await expect(runResult(eff)).rejects.toMatchObject({ cause: new Error("bug") })
  })

  it("interrupted effect (via aborted signal) -> thrown Panic", async () => {
    const controller = new AbortController()
    const eff = Effect.never
    const p = runResult(eff, { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toThrow(Panic)
  })

  it("abort -> Panic carrying the abort reason, matching core /async's convention", async () => {
    const controller = new AbortController()
    const reason = new Error("user cancelled")
    const p = runResult(Effect.never, { signal: controller.signal })
    controller.abort(reason)
    const thrown: unknown = await p.catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(Panic)
    expect((thrown as Panic).cause).toBe(reason)
  })

  it("already-aborted signal -> Panic(abort reason)", async () => {
    const controller = new AbortController()
    controller.abort("gone")
    const thrown: unknown = await runResult(Effect.never, { signal: controller.signal }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(Panic)
    expect((thrown as Panic).cause).toBe("gone")
  })

  it("Effect.gen compositions work", async () => {
    const eff = Effect.gen(function*() {
      const a = yield* Effect.succeed(1)
      const b = yield* Effect.fail("nope")
      return a + b
    })
    const r = await runResult(eff)
    expect(r).toEqual(err("nope"))
  })
})

describe("toEffect", () => {
  it("sync Result Ok -> succeed", async () => {
    const eff = toEffect(ok(1))
    expect(await Effect.runPromise(eff)).toBe(1)
  })

  it("sync Result Err -> fail", async () => {
    const eff = toEffect(err("bad"))
    await expect(Effect.runPromise(eff)).rejects.toBe("bad")
  })

  it("AsyncResult (Promise) -> Effect that resolves then succeeds/fails", async () => {
    const okEff = toEffect(Promise.resolve(ok("v")))
    expect(await Effect.runPromise(okEff)).toBe("v")
    const errEff = toEffect(Promise.resolve(err("bad-async")))
    await expect(Effect.runPromise(errEff)).rejects.toBe("bad-async")
  })

  it("rejecting AsyncResult (Panic) -> Effect.die, never a typed Fail", async () => {
    const panic = new Panic(new Error("bug"))
    const exit = await Effect.runPromise(Effect.exit(toEffect(Promise.reject(panic))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected Failure")
    expect(exit.cause.reasons.map((r) => r._tag)).toEqual(["Die"])
    expect((exit.cause.reasons[0] as { defect: unknown }).defect).toBe(panic)
  })

  it("rejecting AsyncResult (foreign throw) -> Effect.die(original)", async () => {
    const boom = new TypeError("boom")
    const exit = await Effect.runPromise(Effect.exit(toEffect(Promise.reject(boom))))
    if (Exit.isSuccess(exit)) throw new Error("expected Failure")
    expect(exit.cause.reasons.map((r) => r._tag)).toEqual(["Die"])
    expect((exit.cause.reasons[0] as { defect: unknown }).defect).toBe(boom)
  })

  it("round-trip of a defect: runResult(toEffect(rejected Panic)) rethrows the SAME Panic", async () => {
    const panic = new Panic("bug")
    const thrown: unknown = await runResult(toEffect(Promise.reject(panic))).catch((e: unknown) => e)
    expect(thrown).toBe(panic)
  })

  it("round-trip: runResult(toEffect(ok)) === ok", async () => {
    expect(await runResult(toEffect(ok(7)))).toEqual(ok(7))
    expect(await runResult(toEffect(err("x")))).toEqual(err("x"))
  })
})
