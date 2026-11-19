/**
 * Internal helpers shared by the core entry points. NOT part of the public API —
 * never re-exported from `index.ts` or `async.ts`.
 */
import { toPanic } from "./index.ts"

/** Run a user callback; anything it throws is rethrown as `Panic` (an existing `Panic` passes through). */
export const call = <A, B>(f: (a: A) => B, a: A): B => {
  try {
    return f(a)
  } catch (e) {
    throw toPanic(e)
  }
}

/**
 * The async twin of `call`: run `run` and await it; a sync throw OR a rejection comes out as
 * `Panic` (an existing `Panic` passes through). Every `/async` lane awaits user code through this.
 */
export const callAsync = async <A>(run: () => A | PromiseLike<A>): Promise<A> => {
  try {
    return await run()
  } catch (e) {
    throw toPanic(e)
  }
}

/**
 * Dual dispatch on `arguments.length`: `body(self, arg)` when both are given,
 * otherwise return `(self) => body(self, arg)` for use in `pipe`.
 */
export const dual = (body: (self: any, arg: any) => unknown): any =>
  function(a: unknown, b: unknown) {
    return arguments.length > 1 ? body(a, b) : (self: unknown) => body(self, a)
  }
