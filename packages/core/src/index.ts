/**
 * Scaffold stub for `@friday-friday/core` (issue #2).
 *
 * Just enough surface to prove the build (ADR-0002 gate) and to give size-limit
 * a real 5-symbol fixture (ADR-0004). The real implementation (dual combinators,
 * Panic wrapping, pipe/flow overloads) replaces this in issue #3 per RFC-0001.
 */

export interface Ok<out T> {
  readonly ok: true
  readonly value: T
}
export interface Err<out E> {
  readonly ok: false
  readonly error: E
}
export type Result<T, E = never> = Ok<T> | Err<E>

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })

export const err = <E>(error: E): Err<E> => ({ ok: false, error })

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> => r.ok ? ok(f(r.value)) : r

export const andThen = <T, U, E, F>(r: Result<T, E>, f: (t: T) => Result<U, F>): Result<U, E | F> =>
  r.ok ? f(r.value) : r

export const pipe = <A, B>(a: A, ab: (a: A) => B): B => ab(a)
