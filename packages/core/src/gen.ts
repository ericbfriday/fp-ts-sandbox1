/**
 * `@friday-friday/core/gen` — opt-in do-notation (RFC-0001 §4, Design Report §3.5).
 *
 * Plain Results can't carry `[Symbol.iterator]` without becoming non-JSON-clean, so `gen`
 * drives a user generator whose `yield*` delegations go through the `$()` wrapper: the wrapper
 * yields the Err envelope for `gen` to short-circuit on, or immediately returns the Ok value.
 * Results stay pure data — the wire contracts hold for every output.
 *
 * `$()` iterators are one-shot (a Generator is consumed once); create a fresh `$()` per use.
 * Prefer plain `async/await` with early returns for flows of fewer than ~4 steps — generators
 * cost stack-trace quality and some inference time.
 */

import { ok, Panic, type AsyncResult, type Err, type Result } from "./index.js"

/** The error channel extracted from a yielded `Err` envelope. */
type YieldedError<Y> = Y extends Err<infer E> ? E : never

/**
 * Wrap a Result so it can be consumed by `yield*` inside a `gen`/`genAsync` body.
 * One-shot: the returned Generator is consumed by exactly one `yield*` delegation.
 */
export function $<T, E>(r: Result<T, E>): Generator<Err<E>, T, unknown> {
  return (function* () {
    if (r.ok) return r.value
    // Yield hands the Err envelope to `gen`, which short-circuits and never resumes this
    // generator; a manual resume (misuse) throws instead of producing a bogus value.
    yield r
    throw new Panic("a $() iterator was resumed after yielding; drive it via gen/genAsync only")
  })()
}

export function gen<Y extends Err<any>, T>(f: () => Generator<Y, T>): Result<T, YieldedError<Y>> {
  try {
    const iterator = f()
    const step = iterator.next()
    if (step.done) return ok(step.value)
    // Short-circuit on the first yield: it can only be an Err envelope ($ returns Ok values
    // via the generator's return channel, never via yield). Identity is preserved.
    return step.value
  } catch (e) {
    throw e instanceof Panic ? e : new Panic(e)
  }
}

export function genAsync<Y extends Err<any>, T>(
  f: () => AsyncGenerator<Y, T>
): AsyncResult<T, YieldedError<Y>> {
  const drive = async (): Promise<Result<T, YieldedError<Y>>> => {
    try {
      const iterator = f()
      const step = await iterator.next()
      if (step.done) return ok(step.value)
      return step.value
    } catch (e) {
      throw e instanceof Panic ? e : new Panic(e)
    }
  }
  return drive()
}
