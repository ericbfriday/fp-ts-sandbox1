/**
 * `@friday-friday/effect` — Effect bridge (Design Report §5.8).
 *
 * IDEA §4.3 holds in both directions: defects stay defects, and only domain `Err`s travel on
 * the typed channel.
 *
 * - `fromExit` maps an `Exit` to a Result: `Fail` reasons → `Err(e)`; `Die`/`Interrupt` reasons
 *   → thrown `Panic` via core's `toPanic` (a `Die` carrying a `Panic` rethrows that same
 *   instance, never a Panic wrapping a Panic).
 * - `runResult` runs an Effect as an AsyncResult, forwarding an abort `signal` into the fiber. An
 *   abort is a defect, `Panic(abort reason)`, matching core `/async`'s user-abort convention.
 * - `toEffect` lifts a Result/AsyncResult into an Effect: `Ok` → `succeed`, `Err` → `fail`, and
 *   a rejecting AsyncResult (a defect) → `die` with the rejection as the defect.
 *
 * Effect services stay behind server-side interpreters; this adapter only ever sees Results on
 * one side and `@stability stable` members of `effect`'s root entry on the other (IDEA §4.10;
 * `test/stability.test.ts` checks every member used against the installed effect's JSDoc).
 *
 * Bridge functions only (#44 decision 6, #64): import `Effect`/`Exit`/`Cause` from `effect` and
 * Result primitives from `@friday-friday/core`.
 */
import { type AsyncResult, err, ok, type Result, toPanic } from "@friday-friday/core"
import { Cause, Effect, Exit } from "effect"

/**
 * `Exit` → `Result`: `Fail(E)` → `Err(E)`; `Die`/`Interrupt` → thrown `Panic` (core `toPanic`).
 *
 * A `Cause` may carry MULTIPLE reasons. The bridge's precedence is deliberate: Die, then
 * Interrupt, then Fail. A die anywhere means a bug happened, and failures next to it are
 * secondary. This is NOT Effect's own ordering: `Cause.squash` (what `Effect.runPromise`
 * throws) returns the first `Fail` ahead of any `Die`.
 */
export function fromExit<A, E>(exit: Exit.Exit<A, E>): Result<A, E> {
  return settle(exit, (fiberId) => `fiber interrupted: ${String(fiberId ?? "unknown")}`)
}

export interface RunResultOptions {
  /** Forwarded into the fiber; an abort surfaces as a thrown `Panic(signal.reason)`. */
  readonly signal?: AbortSignal
}

/**
 * Run an Effect (no requirements) as an AsyncResult: failures → `Err(E)`, dies → thrown `Panic`
 * (precedence as in `fromExit`). The `signal` is forwarded into the fiber; an abort that
 * interrupts it (including an already-aborted signal) rejects with `Panic(signal.reason)`.
 */
export function runResult<A, E>(effect: Effect.Effect<A, E>, opts?: RunResultOptions): AsyncResult<A, E> {
  const signal = opts?.signal
  return Effect.runPromiseExit(effect, signal === undefined ? undefined : { signal }).then((exit) =>
    settle(
      exit,
      (fiberId) => signal?.aborted ? signal.reason ?? "aborted" : `fiber interrupted: ${String(fiberId ?? "unknown")}`
    )
  )
}

/**
 * Lift a Result/AsyncResult into an Effect: `Ok(v)` → `Effect.succeed(v)`, `Err(e)` →
 * `Effect.fail(e)`. An AsyncResult that REJECTS carries a defect (core lanes reject with
 * `Panic`), so it becomes `Effect.die(rejection)`, never a typed failure. Requirements stay
 * `never`: adapters never introduce Effect services.
 */
export function toEffect<T, E>(r: Result<T, E> | AsyncResult<T, E>): Effect.Effect<T, E> {
  // `Effect.promise` turns a rejection into a Die; only the resolved Result reaches `fail`.
  return isThenable(r) ? Effect.flatMap(Effect.promise(() => r), fromResult) : fromResult(r)
}

const fromResult = <T, E>(r: Result<T, E>): Effect.Effect<T, E> => r.ok ? Effect.succeed(r.value) : Effect.fail(r.error)

/** The one Exit triage: Die, then Interrupt (cause chosen by the caller), then Fail. */
const settle = <A, E>(exit: Exit.Exit<A, E>, interrupted: (fiberId: number | undefined) => unknown): Result<A, E> => {
  if (Exit.isSuccess(exit)) return ok(exit.value)
  const { reasons } = exit.cause
  const die = reasons.find(Cause.isDieReason)
  if (die !== undefined) throw toPanic(die.defect)
  const interrupt = reasons.find(Cause.isInterruptReason)
  if (interrupt !== undefined) throw toPanic(interrupted(interrupt.fiberId))
  const fail = reasons.find(Cause.isFailReason)
  if (fail !== undefined) return err(fail.error)
  // Empty cause (theoretically unreachable for a Failure): treat as a defect.
  throw toPanic(exit.cause)
}

const isThenable = (u: unknown): u is PromiseLike<unknown> =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe: then verified as function below
  typeof u === "object" && u !== null && typeof (u as PromiseLike<unknown>).then === "function"
