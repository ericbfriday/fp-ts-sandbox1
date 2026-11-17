/**
 * `@friday-friday/effect` — Effect bridge (Design Report §5.8).
 *
 * `fromExit` maps an `Exit` to a Result: `Fail` reasons → `Err(e)`; `Die`/`Interrupt`
 * reasons → thrown `Panic(defect)` (die/interrupt are bugs or cancellations, never values).
 * `runResult` runs an Effect as an AsyncResult, forwarding an abort `signal` into the
 * fiber (cancellation surfaces as `Interrupt` → `Panic`, per the same rule).
 * `toEffect` lifts a Result/AsyncResult back into an Effect (`succeed`/`fail`).
 *
 * Effect services stay behind server-side interpreters; this adapter only ever sees
 * Results on one side and `@stability`-stable Effect modules on the other (`Exit`,
 * `Cause`, `runPromise`, `exit`, `succeed`, `fail`, `suspend` — all `@stability stable`
 * in effect 4.0.6). Per the report, CI runs the matrix against `effect` so minor-version
 * breaks in unstable modules surface immediately.
 */
import { type AsyncResult, err, ok, Panic, type Result } from "@friday-friday/core"
import { Cause, Effect, Exit } from "effect"

export { Cause, Effect, Exit }

/**
 * `Exit` → `Result`: `Fail(E)` → `Err(E)`; `Die`/`Interrupt` → thrown `Panic(defect)`.
 * A `Cause` may carry MULTIPLE reasons — a `Die` anywhere means "a bug happened" and wins
 * (failures next to a die are secondary), matching Effect's own severity ordering.
 */
export function fromExit<A, E>(exit: Exit.Exit<A, E>): Result<A, E> {
  if (Exit.isSuccess(exit)) return ok(exit.value)
  const dieReason = exit.cause.reasons.find((r) => r._tag === "Die")
  if (dieReason !== undefined) {
    throw new Panic((dieReason as { defect: unknown }).defect)
  }
  const interruptReason = exit.cause.reasons.find((r) => r._tag === "Interrupt")
  if (interruptReason !== undefined) {
    throw new Panic(
      `fiber interrupted: ${String((interruptReason as { fiberId?: number | undefined }).fiberId ?? "unknown")}`
    )
  }
  const failReason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (failReason !== undefined) return err((failReason as { error: E }).error)
  // Empty cause (theoretically unreachable for a Failure): treat as a defect.
  throw new Panic(exit.cause)
}

export interface RunResultOptions {
  /** Forwarded into the fiber; expiry surfaces as `Interrupt` → thrown `Panic`. */
  readonly signal?: AbortSignal
}

/**
 * Run an Effect (no requirements) as an AsyncResult: failures → `Err(E)`, dies/interrupts
 * → thrown `Panic`. The `signal` is forwarded into `Effect.runPromise`'s fiber options.
 */
export function runResult<A, E>(effect: Effect.Effect<A, E>, opts?: RunResultOptions): AsyncResult<A, E> {
  return (async () => {
    const runOpts: { signal?: AbortSignal } | undefined = opts?.signal !== undefined
      ? { signal: opts.signal }
      : undefined
    const exit = runOpts !== undefined
      ? await Effect.runPromise(Effect.exit(effect), runOpts)
      : await Effect.runPromise(Effect.exit(effect))
    return fromExit(exit)
  })()
}

/**
 * Lift a Result/AsyncResult into an Effect: `Ok(v)` → `Effect.succeed(v)`,
 * `Err(e)` → `Effect.fail(e)`. Requirements stay `never` — adapters never introduce
 * Effect services.
 */
export function toEffect<T, E>(r: Result<T, E> | AsyncResult<T, E>): Effect.Effect<T, E> {
  if (isThenable(r)) {
    // Async lane: await the Promise<Result>; the Err is carried out via a private marker
    // and mapped back into Effect.fail by tryPromise's catch (only our throw lands there).
    return Effect.tryPromise({
      try: async () => {
        const res = await r
        if (res.ok) return res.value
        throw new ErrCarrier(res.error)
      },
      // oxlint-disable-next-line no-unsafe-type-assertion -- only our ErrCarrier rejection can land here (the awaited Result never rejects)
      catch: (e) => (e instanceof ErrCarrier ? e.error : (e as E))
    })
  }
  return r.ok ? Effect.succeed(r.value) : Effect.fail(r.error)
}

const isThenable = (u: unknown): u is PromiseLike<unknown> =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe: then verified as function below
  typeof u === "object" && u !== null && typeof (u as PromiseLike<unknown>).then === "function"

/** Private marker: an Err's error crossing tryPromise's rejection channel. */
class ErrCarrier<T> extends Error {
  readonly error: T
  constructor(error: T) {
    super("ErrCarrier")
    this.error = error
  }
}
