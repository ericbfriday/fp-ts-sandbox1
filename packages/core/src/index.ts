/**
 * `@friday-friday/core` — sync surface (RFC-0001 §1–§4, Design Report §3.1–§3.4).
 *
 * - Results are plain data (`{ ok, value } | { ok, error }`): no classes, no prototypes,
 *   so they survive `structuredClone`, RSC payloads and `JSON.stringify` unchanged.
 * - Tagged errors are plain data with a literal `_tag` and a structural `is()` guard
 *   (never `instanceof`: duplicate module copies break it).
 * - Defects are thrown, not values: a callback that throws inside a combinator is rethrown
 *   as `Panic` with the original as `cause`.
 * - Every combinator is dual (data-first and data-last, dispatched on `arguments.length`)
 *   and a separate `#__PURE__`-annotated export so unused ones tree-shake.
 * - `pipe` / `flow` are explicit overloads (16 / 12 arity): no recursive types, no HKTs.
 * - Every export carries an explicit type so the package is `isolatedDeclarations` clean.
 */

// ---------------------------------------------------------------------------
// §1 Result shape
// ---------------------------------------------------------------------------

export interface Ok<out T> {
  readonly ok: true
  readonly value: T
}

export interface Err<out E> {
  readonly ok: false
  readonly error: E
}

/** `E` defaults to `never`; error unions grow by `|` only (through `andThen` / `orElse`). */
export type Result<T, E = never> = Ok<T> | Err<E>

export type AsyncResult<T, E = never> = Promise<Result<T, E>>

/** The `T` of a `Result` (or `Ok`) type; `never` for `Err`. */
export type InferOk<R> = R extends Ok<infer T> ? T : never

/** The `E` of a `Result` (or `Err`) type; `never` for `Ok`. */
export type InferErr<R> = R extends Err<infer E> ? E : never

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })

export const err = <E>(error: E): Err<E> => ({ ok: false, error })

/** Structural guard: `{ ok: true, value }` or `{ ok: false, error }` — arrays, `null`, `{ ok: "x" }` are rejected. */
export const isResult = (u: unknown): u is Result<unknown, unknown> =>
  typeof u === "object" && u !== null && "ok" in u && typeof u.ok === "boolean" &&
  (u.ok ? "value" in u : "error" in u)

// ---------------------------------------------------------------------------
// §2 Error taxonomy — plain data with a literal `_tag`
// ---------------------------------------------------------------------------

export interface TaggedError<Tag extends string> {
  readonly _tag: Tag
  readonly message?: string
}

export interface ErrorFactory<Tag extends string, P extends object> {
  (props: P & { message?: string; cause?: unknown }): TaggedError<Tag> & Readonly<P>
  readonly tag: Tag
  /** Structural: `u._tag === tag`. Works across module copies, `JSON.parse` output and `structuredClone`. */
  is(u: unknown): u is TaggedError<Tag> & Readonly<P>
}

/**
 * Build a tagged-error factory. Usage (explicit annotation + `ReturnType` twin type):
 *
 * ```ts
 * export const NotFound: ErrorFactory<"NotFound", { resource: string; id: string }> =
 *   taggedError("NotFound")<{ resource: string; id: string }>()
 * export type NotFound = ReturnType<typeof NotFound>
 * ```
 *
 * `cause` is kept on the object at runtime (server-side only) but is not part of the
 * public type: sanitizers strip it before any boundary (RFC-0001 §5).
 */
export function taggedError<const Tag extends string>(tag: Tag): <P extends object = {}>() => ErrorFactory<Tag, P> {
  return <P extends object = {}>(): ErrorFactory<Tag, P> =>
    Object.assign(
      (props: P & { message?: string; cause?: unknown }): TaggedError<Tag> & Readonly<P> => ({ _tag: tag, ...props }),
      {
        tag,
        is: (u: unknown): u is TaggedError<Tag> & Readonly<P> =>
          typeof u === "object" && u !== null && "_tag" in u && u._tag === tag
      }
    )
}

/** A real `Error` built from a tagged error: `name` is the `_tag`, the error itself is `data`. */
export interface Throwable<E extends TaggedError<string>> extends Error {
  name: E["_tag"]
  readonly data: E
}

/**
 * Wrap a tagged error in a real `Error` for the few places that need one (Error Boundaries,
 * `catchError`, logging stacks). The tagged error's own `cause`, if any, becomes the `Error`'s
 * `cause` so logging keeps the full chain.
 */
export const toThrowable = <E extends TaggedError<string>>(e: E): Throwable<E> =>
  Object.assign(new Error(e.message, "cause" in e ? { cause: e.cause } : undefined), { name: e._tag, data: e })

// ---------------------------------------------------------------------------
// §3 Defects
// ---------------------------------------------------------------------------

/**
 * A defect: a callback passed to a combinator threw. The original throw is `cause`.
 * Never appears in `E`; adapters sanitize it into `InternalDefect` at the edge.
 */
export class Panic extends Error {
  override readonly name = "Panic" as const
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/** Run a user callback; anything it throws is rethrown as `Panic` (an existing `Panic` passes through). */
const call = <A, B>(f: (a: A) => B, a: A): B => {
  try {
    return f(a)
  } catch (e) {
    throw e instanceof Panic ? e : new Panic(e)
  }
}

/**
 * Dual dispatch on `arguments.length`: `body(self, arg)` when both are given,
 * otherwise return `(self) => body(self, arg)` for use in `pipe`.
 */
const dual = (body: (self: any, arg: any) => unknown): any =>
  function(a: unknown, b: unknown) {
    return arguments.length > 1 ? body(a, b) : (self: unknown) => body(self, a)
  }

// ---------------------------------------------------------------------------
// §3 Boundary triage (sync half). Async triage (tryAsync + signal) lands with
// the /async subpath; the options shape is shared by both.
// ---------------------------------------------------------------------------

export interface TryOptions<E> {
  /** Map an unknown throw to a domain error, or return `undefined` to treat it as a defect (rethrow). */
  readonly catch: (cause: unknown) => E | undefined
  /** Framework sentinels to rethrow before mapping (e.g. Next.js redirect/notFound); called first. */
  readonly rethrow?: (cause: unknown) => void
  /** Cancellation is an async concern; accepted here so sync/async call sites can share options. */
  readonly signal?: AbortSignal
}

export interface TrySync {
  <T, E>(fn: () => T, opts: TryOptions<E>): Result<T, E>
}

/**
 * Run `fn`, triaging every throw at the boundary (RFC-0001 §3):
 * `rethrow` runs first so framework sentinels propagate untouched; then `catch` maps the
 * cause to a domain error — returning `undefined` means "defect", rethrown as `Panic`.
 */
export const trySync: TrySync = /*#__PURE__*/ <T, E>(fn: () => T, opts: TryOptions<E>): Result<T, E> => {
  try {
    return ok(fn())
  } catch (cause) {
    opts.rethrow?.(cause)
    const mapped = call(opts.catch, cause)
    if (mapped === undefined) throw new Panic(cause)
    return err(mapped)
  }
}

// ---------------------------------------------------------------------------
// §4 Combinators — pure, pipeable, dual, separate `/*#__PURE__*/` exports
// ---------------------------------------------------------------------------

export const map: {
  <T, U>(f: (value: T) => U): <E = never>(r: Result<T, E>) => Result<U, E>
  <T, U, E = never>(r: Result<T, E>, f: (value: T) => U): Result<U, E>
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, f: (value: unknown) => unknown) => r.ok ? ok(call(f, r.value)) : r)

export const mapErr: {
  <E, F>(f: (error: E) => F): <T>(r: Result<T, E>) => Result<T, F>
  <T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F>
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, f: (error: unknown) => unknown) =>
  r.ok ? r : err(call(f, r.error))
)

export const andThen: {
  <T, U, F = never>(f: (value: T) => Result<U, F>): <E = never>(r: Result<T, E>) => Result<U, E | F>
  <T, U, E = never, F = never>(r: Result<T, E>, f: (value: T) => Result<U, F>): Result<U, E | F>
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, f: (value: unknown) => unknown) => r.ok ? call(f, r.value) : r)

export const orElse: {
  <E, U, F = never>(f: (error: E) => Result<U, F>): <T>(r: Result<T, E>) => Result<T | U, F>
  <T, E, U, F = never>(r: Result<T, E>, f: (error: E) => Result<U, F>): Result<T | U, F>
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, f: (error: unknown) => unknown) => r.ok ? r : call(f, r.error))

/** Run `f` on the value for its effect; the Result is returned unchanged (same object). */
export const tap: {
  <T>(f: (value: T) => void): <E = never>(r: Result<T, E>) => Result<T, E>
  <T, E = never>(r: Result<T, E>, f: (value: T) => void): Result<T, E>
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, f: (value: unknown) => void) => {
  if (r.ok) call(f, r.value)
  return r
})

/** Run `f` on the error for its effect; the Result is returned unchanged (same object). */
export const tapErr: {
  <E>(f: (error: E) => void): <T>(r: Result<T, E>) => Result<T, E>
  <T, E>(r: Result<T, E>, f: (error: E) => void): Result<T, E>
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, f: (error: unknown) => void) => {
  if (!r.ok) call(f, r.error)
  return r
})

export const unwrapOr: {
  <D>(fallback: D): <T, E = never>(r: Result<T, E>) => T | D
  <T, D, E = never>(r: Result<T, E>, fallback: D): T | D
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, fallback: unknown) => r.ok ? r.value : fallback)

export interface MatchHandlers<T, E, A, B> {
  readonly ok: (value: T) => A
  readonly err: (error: E) => B
}

export const match: {
  <T, E, A, B>(handlers: MatchHandlers<T, E, A, B>): (r: Result<T, E>) => A | B
  <T, E, A, B>(r: Result<T, E>, handlers: MatchHandlers<T, E, A, B>): A | B
} = /*#__PURE__*/ dual((r: Result<unknown, unknown>, h: MatchHandlers<unknown, unknown, unknown, unknown>) =>
  r.ok ? call(h.ok, r.value) : call(h.err, r.error)
)

export interface Tagged {
  readonly _tag: string
}

/** One handler for `ok` plus one per `_tag` in `E` — exhaustive by construction. */
export type TagHandlers<T, E extends Tagged> =
  & { readonly ok: (value: T) => unknown }
  & { readonly [K in E["_tag"]]: (error: Extract<E, { readonly _tag: K }>) => unknown }

export const matchTag: {
  /** Data-first: `T`/`E` come from `r`; `NoInfer` keeps the handlers from polluting inference.
   * `E = never` default: a bare `Ok<number>` argument matches only the `Ok` branch, leaving `E`
   * uninferred — without the default it falls back to `Tagged` and demands every tag handler. */
  <T, E extends Tagged = never, H extends NoInfer<TagHandlers<T, E>> = NoInfer<TagHandlers<T, E>>>(
    r: Result<T, E>,
    handlers: H
  ): ReturnType<H[keyof H]>
  /** Data-last, unannotated handlers: `T`/`E` stay open here and unify where the returned function is applied. */
  <T, E extends Tagged, H extends TagHandlers<T, E>>(handlers: H): (r: Result<T, E>) => ReturnType<H[keyof H]>
  /** Data-last, annotated handlers (standalone `const f = matchTag({ ok: (n: number) => ... })`):
   * the strict overload rejects annotated params while `T` is unresolved (contravariance), so this
   * loose overload carries exhaustiveness through the returned function's `E` constraint instead. */
  <H extends { readonly ok: (value: any) => unknown } & { readonly [tag: string]: (error: any) => unknown }>(
    handlers: H
  ): <
    T extends H extends { readonly ok: (value: infer T2) => unknown } ? T2 : never,
    E extends Tagged & { readonly _tag: Exclude<keyof H, "ok"> & string }
  >(
    r: Result<T, E>
  ) => ReturnType<H[keyof H]>
} = /*#__PURE__*/ dual((r: Result<unknown, Tagged>, h: TagHandlers<unknown, Tagged>) =>
  r.ok ? call(h.ok, r.value) : call(h[r.error._tag]!, r.error)
)

/** No Option type: lift `T | null | undefined` into a Result, building the error lazily. */
export const fromNullable: {
  <E>(onNone: () => E): <T>(value: T) => Result<NonNullable<T>, E>
  <T, E>(value: T, onNone: () => E): Result<NonNullable<T>, E>
} = /*#__PURE__*/ dual((value: unknown, onNone: () => unknown) =>
  value == null ? err(call(onNone, undefined)) : ok(value)
)

/** All `Ok` → `Ok` of the values (tuple-aware); otherwise the first `Err` in input order (same object).
 *
 * Two overloads because TS can't do both jobs in one constraint: a variadic-tuple param forces
 * tuple inference for literals (a plain `const R extends ReadonlyArray<...>` mangles element
 * unions — TS infers only the `Err` branch per element), while a generic `ReadonlyArray` overload
 * handles array inputs (tuple params reject `Array<T>`: "no match at position 0").
 */
export interface All {
  <R extends readonly [] | readonly [Result<unknown, unknown>, ...Array<Result<unknown, unknown>>]>(
    results: R
  ): Result<{ -readonly [K in keyof R]: InferOk<R[K]> }, InferErr<R[number]>>
  <T, E>(results: ReadonlyArray<Result<T, E>>): Result<Array<T>, E>
}

/** All `Ok` → `Ok` of the values (tuple-aware); otherwise the first `Err` in input order (same object).
 *
 * Two overloads because TS can't do both jobs in one constraint: a variadic-tuple param forces
 * tuple inference for literals (a plain `const R extends ReadonlyArray<...>` mangles element
 * unions — TS infers only the `Err` branch per element), while a generic `ReadonlyArray` overload
 * handles array inputs (tuple params reject `Array<T>`: "no match at position 0"). The
 * implementation is a concrete-typed function cast to `All` — a generic body cannot satisfy the
 * generic signature directly (unknown is not assignable to T), same trick as `dual`'s `any`.
 */
export const all: All = /*#__PURE__*/ (
  results: ReadonlyArray<Result<unknown, unknown>>
): Result<Array<unknown>, unknown> => {
  const values: Array<unknown> = []
  for (const r of results) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
  // The concrete impl cannot satisfy the mapped-tuple overload generically (unknown vs T) —
  // same reason dual() leans on `any`. Deliberate idiom, not a shortcut.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above
}

export interface Partition {
  <T, E>(results: ReadonlyArray<Result<T, E>>): [Array<T>, Array<E>]
}

/** Split into `[values, errors]`, each in input order. */
export const partition: Partition = /*#__PURE__*/ <T, E>(
  results: ReadonlyArray<Result<T, E>>
): [Array<T>, Array<E>] => {
  const values: Array<T> = []
  const errors: Array<E> = []
  for (const r of results) {
    if (r.ok) values.push(r.value)
    else errors.push(r.error)
  }
  return [values, errors]
}

// ---------------------------------------------------------------------------
// pipe / flow — explicit overloads, no recursive types
// ---------------------------------------------------------------------------

export function pipe<A>(a: A): A
export function pipe<A, B>(a: A, ab: (a: A) => B): B
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C
export function pipe<A, B, C, D>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D
export function pipe<A, B, C, D, E>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E
export function pipe<A, B, C, D, E, F>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F
): F
export function pipe<A, B, C, D, E, F, G>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G
): G
export function pipe<A, B, C, D, E, F, G, H>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H
): H
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I
): I
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J
): J
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K
): K
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L
): L
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
  lm: (l: L) => M
): M
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
  lm: (l: L) => M,
  mn: (m: M) => N
): N
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
  lm: (l: L) => M,
  mn: (m: M) => N,
  no: (n: N) => O
): O
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
  lm: (l: L) => M,
  mn: (m: M) => N,
  no: (n: N) => O,
  op: (o: O) => P
): P
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
  lm: (l: L) => M,
  mn: (m: M) => N,
  no: (n: N) => O,
  op: (o: O) => P,
  pq: (p: P) => Q
): Q
export function pipe(a: unknown, ...fns: Array<(x: unknown) => unknown>): unknown {
  return fns.reduce((x, f) => f(x), a)
}

export function flow<A extends ReadonlyArray<unknown>, B>(ab: (...a: A) => B): (...a: A) => B
export function flow<A extends ReadonlyArray<unknown>, B, C>(ab: (...a: A) => B, bc: (b: B) => C): (...a: A) => C
export function flow<A extends ReadonlyArray<unknown>, B, C, D>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D
): (...a: A) => D
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E
): (...a: A) => E
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F
): (...a: A) => F
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G
): (...a: A) => G
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G, H>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H
): (...a: A) => H
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G, H, I>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I
): (...a: A) => I
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G, H, I, J>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J
): (...a: A) => J
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G, H, I, J, K>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K
): (...a: A) => K
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G, H, I, J, K, L>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L
): (...a: A) => L
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F, G, H, I, J, K, L, M>(
  ab: (...a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
  lm: (l: L) => M
): (...a: A) => M
export function flow(
  first: (...args: Array<unknown>) => unknown,
  ...rest: Array<(x: unknown) => unknown>
): (...args: Array<unknown>) => unknown {
  return (...args) => rest.reduce((x, f) => f(x), first(...args))
}
