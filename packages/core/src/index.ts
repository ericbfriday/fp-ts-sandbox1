/**
 * `@friday-friday/core` — sync surface (RFC-0001 §1–§4, Design Report §3.1–§3.4).
 *
 * - Results are plain data (`{ ok, value } | { ok, error }`): no classes, no prototypes,
 *   so they survive `structuredClone`, RSC payloads and `JSON.stringify` unchanged.
 * - Tagged errors are plain data with a literal `_tag` and a structural `is()` guard
 *   (never `instanceof`: duplicate module copies break it).
 * - Defects are thrown, not values: a callback that throws inside a combinator is rethrown
 *   as `Panic` with the original as `cause`, through the one idempotent `toPanic` conversion.
 * - Every combinator is dual (data-first and data-last, dispatched on `arguments.length`)
 *   and a separate `#__PURE__`-annotated export so unused ones tree-shake.
 * - `pipe` / `flow` are explicit overloads (16 / 12 arity): no recursive types, no HKTs.
 * - Every export carries an explicit type so the package is `isolatedDeclarations` clean.
 */

import { call, dual } from "./internal.js"

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
  /** `_tag?: never`: the factory owns its tag, so a `_tag` prop (even one spread in) is a type error. */
  (props: P & { message?: string; cause?: unknown; _tag?: never }): TaggedError<Tag> & Readonly<P>
  readonly tag: Tag
  /** Structural: `u._tag === tag`. Works across module copies, `JSON.parse` output and `structuredClone`. */
  is(u: unknown): u is TaggedError<Tag> & Readonly<P>
}

/**
 * The fixed vocabulary's props by tag (ADR-0005). Core's seven come from the factories below
 * (their annotations, not their initializers, so this is not circular). Schema owns
 * `ValidationFailure`, whose `issues` is the one required prop of a fixed tag.
 */
interface FixedProps {
  readonly NotFound: Omit<NotFound, keyof TaggedError<"NotFound">>
  readonly Conflict: Omit<Conflict, keyof TaggedError<"Conflict">>
  readonly Forbidden: Omit<Forbidden, keyof TaggedError<"Forbidden">>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- `{}` today (ADR-0005: no props), derived so it can't drift
  readonly Unauthenticated: Omit<Unauthenticated, keyof TaggedError<"Unauthenticated">>
  readonly Timeout: Omit<Timeout, keyof TaggedError<"Timeout">>
  readonly NetworkError: Omit<NetworkError, keyof TaggedError<"NetworkError">>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- `{}` today (ADR-0005: no props), derived so it can't drift
  readonly DbUnavailable: Omit<DbUnavailable, keyof TaggedError<"DbUnavailable">>
  readonly ValidationFailure: {
    readonly issues: ReadonlyArray<{ readonly message: string; readonly path: ReadonlyArray<string | number> }>
  }
}

/** The keys of `T` that are not optional. */
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]

/** Why prop `K` of `P` breaks ADR-0005 for the fixed tag `Tag` with core props `C`; `never` when it doesn't. */
type FixedPropViolation<Tag extends string, K, P, C> = K extends RequiredKeys<C>
  ? K extends RequiredKeys<P> ? Retyped<Tag, K, P, C> : `is required by "${Tag}"`
  : K extends RequiredKeys<P> ? `must be optional: "${Tag}" is a fixed tag`
  : Retyped<Tag, K, P, C>

/** A prop core declares must keep core's type (`id?: number` on `NotFound` is a retype). */
type Retyped<Tag extends string, K, P, C> = K extends keyof P & keyof C
  ? [P[K]] extends [C[K]] ? never : `must keep core's "${Tag}" type`
  : never

/**
 * `taggedError`'s check on `P` for a fixed tag (ADR-0005, #92): every prop is optional unless
 * core requires it, and every prop core declares keeps core's type. A violation turns the
 * constraint into `{ "ADR-0005": { [prop]: why } }`, which no props type satisfies.
 * `{}` always passes, so the `= {}` default type-checks while `Tag` is generic. Known gap:
 * `taggedError("ValidationFailure")()` compiles, since TS never checks a default against its
 * constraint at a call site.
 */
type FixedTagRule<Tag extends keyof FixedProps, P> = [keyof P] extends [never] ? object : Ruling<
  {
    readonly [
      K in keyof P | RequiredKeys<FixedProps[Tag]> as FixedPropViolation<Tag, K, P, FixedProps[Tag]> extends never ?
        never
        : K
    ]: FixedPropViolation<Tag, K, P, FixedProps[Tag]>
  }
>

/** `object` when nothing is wrong; otherwise a type no props object satisfies, naming each bad prop. */
type Ruling<Violations> = [keyof Violations] extends [never] ? object : { readonly "ADR-0005": Violations }

/**
 * Build a tagged-error factory. Usage (explicit annotation + `ReturnType` twin type):
 *
 * ```ts
 * export const PaymentDeclined: ErrorFactory<"PaymentDeclined", { reason: string }> =
 *   taggedError("PaymentDeclined")<{ reason: string }>()
 * export type PaymentDeclined = ReturnType<typeof PaymentDeclined>
 * ```
 *
 * For a fixed tag, import core's factory below (ADR-0005); an app tag may require props.
 * A package that extends a fixed tag may add only optional props and must keep core's prop
 * types: anything else fails `P`'s constraint, naming each bad prop under `"ADR-0005"` (#92).
 * App and adapter tags take the second overload, unconstrained.
 *
 * `cause` is kept on the object at runtime (server-side only) but is not part of the
 * public type: sanitizers strip it before any boundary (RFC-0001 §5).
 */
export function taggedError<const Tag extends keyof FixedProps>(
  tag: Tag
): <P extends object & FixedTagRule<Tag, P> = {}>() => ErrorFactory<Tag, P>
export function taggedError<const Tag extends string>(tag: Tag): <P extends object = {}>() => ErrorFactory<Tag, P>
export function taggedError<const Tag extends string>(tag: Tag): <P extends object = {}>() => ErrorFactory<Tag, P> {
  return <P extends object = {}>(): ErrorFactory<Tag, P> =>
    Object.assign(
      (props: P & { message?: string; cause?: unknown }): TaggedError<Tag> & Readonly<P> => {
        // The factory owns `_tag` (#60): a `_tag` in props (spread in, or off-the-wire data) is
        // overwritten. Assigned after the spread so `_tag` stays the first key in JSON output.
        const e = { _tag: tag, ...props }
        e._tag = tag
        return e
      },
      {
        tag,
        is: (u: unknown): u is TaggedError<Tag> & Readonly<P> =>
          typeof u === "object" && u !== null && "_tag" in u && u._tag === tag
      }
    )
}

// ---------------------------------------------------------------------------
// §2 Fixed vocabulary — ADR-0005: core owns one factory per fixed tag (schema owns
// `ValidationFailure`). A fixed tag guarantees only `_tag` and an optional `message`: every
// other prop is optional and JSON-safe, so narrowing through any package's `is()` stays sound
// for errors built in-process. Errors rebuilt from the wire carry untrusted JSON: read their
// props as hints. `/*#__PURE__*/` keeps each factory out of bundles that don't use it.
// ---------------------------------------------------------------------------

/** Domain tag: the thing asked for does not exist. */
export const NotFound: ErrorFactory<"NotFound", { readonly resource?: string; readonly id?: string }> =
  /*#__PURE__*/ taggedError("NotFound")<{ readonly resource?: string; readonly id?: string }>()
export type NotFound = ReturnType<typeof NotFound>

/** Domain tag: the write clashes with existing state (a unique key, a stale version). */
export const Conflict: ErrorFactory<"Conflict", { readonly field?: string; readonly constraint?: string }> =
  /*#__PURE__*/ taggedError("Conflict")<{ readonly field?: string; readonly constraint?: string }>()
export type Conflict = ReturnType<typeof Conflict>

/** Domain tag: authenticated, but lacking the permission or role named by `required`. */
export const Forbidden: ErrorFactory<"Forbidden", { readonly required?: string }> = /*#__PURE__*/ taggedError(
  "Forbidden"
)<{ readonly required?: string }>()
export type Forbidden = ReturnType<typeof Forbidden>

/** Domain tag: no (valid) session. */
export const Unauthenticated: ErrorFactory<"Unauthenticated", {}> = /*#__PURE__*/ taggedError("Unauthenticated")()
export type Unauthenticated = ReturnType<typeof Unauthenticated>

/** Infrastructure tag: a time budget of `ms` milliseconds ran out (`/async` `timeout()` produces it). */
export const Timeout: ErrorFactory<"Timeout", { readonly ms?: number }> = /*#__PURE__*/ taggedError("Timeout")<
  { readonly ms?: number }
>()
export type Timeout = ReturnType<typeof Timeout>

/** Infrastructure tag: the transport failed before a response arrived. */
export const NetworkError: ErrorFactory<"NetworkError", { readonly reason?: string }> = /*#__PURE__*/ taggedError(
  "NetworkError"
)<{ readonly reason?: string }>()
export type NetworkError = ReturnType<typeof NetworkError>

/** Infrastructure tag: the database can't be reached (connection failures). */
export const DbUnavailable: ErrorFactory<"DbUnavailable", {}> = /*#__PURE__*/ taggedError("DbUnavailable")()
export type DbUnavailable = ReturnType<typeof DbUnavailable>

/** A real `Error` built from a tagged error: `name` is the `_tag`, the error itself is `data`. */
export interface Throwable<E extends TaggedError<string>> extends Error {
  name: E["_tag"]
  readonly data: E
}

/**
 * Wrap a tagged error in a real `Error` for the few places that need one (Error Boundaries,
 * `catchError`, logging stacks). The Error never has a `cause` (RFC-0001 §2: `cause` stays
 * server-side): React's dev Flight serializer sends any `cause` on a thrown Error to the browser
 * (#53). Server-side logging reaches it through `data.cause`.
 */
export const toThrowable = <E extends TaggedError<string>>(e: E): Throwable<E> =>
  Object.assign(new Error(e.message), { name: e._tag, data: e })

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
    super(describeCause(cause), { cause })
  }
}

/**
 * A short, bounded log line for any thrown value (RFC-0001 §3) that never prints the value's
 * data: a primitive via `String()` (a string as-is); an object or function only by its string
 * `_tag` and `message` (`name` standing in for a missing message), so a tagged error reads
 * `Tag: message` and an `Error` its message; anything else `"Non-Error thrown"`. A thrown config
 * object can't leak its secrets into logs, and the full value stays on `.cause`. Capped at 200
 * chars. Total: a revoked Proxy or a throwing getter gives `"Unprintable thrown value"`.
 */
const describeCause = (cause: unknown): string => {
  try {
    const { _tag, message, name }: { _tag?: unknown; message?: unknown; name?: unknown } = Object(cause)
    return (Object(cause) !== cause
      ? String(cause)
      : [_tag, message || name].filter((part) => typeof part === "string" && part).join(": ") || "Non-Error thrown")
      .slice(0, 200)
  } catch {
    return "Unprintable thrown value"
  }
}

/** `instanceof Panic`, total: a revoked Proxy throws from `instanceof`, and is no Panic. */
const isPanic = (u: unknown): u is Panic => {
  try {
    return u instanceof Panic
  } catch {
    return false
  }
}

/**
 * The one defect conversion every lane uses (IDEA §4.3, RFC-0001 §3): a foreign throw becomes
 * `Panic` with the original as `cause`; an existing `Panic` is returned as the SAME instance, so
 * nested combinators and adapters never double-wrap. Exported for adapters and bridges that
 * triage throws at their own seam (rethrow framework sentinels first, then `throw toPanic(cause)`).
 * Recognises `Panic` by `instanceof`: a Panic from a duplicate copy of core is wrapped once more.
 * Total: never throws, whatever was thrown (revoked Proxy, throwing getters, null prototype).
 */
export const toPanic = (cause: unknown): Panic => isPanic(cause) ? cause : new Panic(cause)

/** Boundary triage (sync half; the async half lives in `./async.js`). */

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
    if (mapped === undefined) throw toPanic(cause)
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
} = /*#__PURE__*/ dual((r: Result<unknown, Tagged>, h: TagHandlers<unknown, Tagged>) => {
  if (r.ok) return call(h.ok, r.value)
  const tag = r.error._tag
  // A tag with no handler (rebuilt from the wire, or outside the type's E) is a defect (#60).
  // Own handlers only, never `ok`: an inherited `constructor`/`toString` or the `ok` handler must
  // not be dispatched to by a stray tag.
  if (tag === "ok" || !Object.hasOwn(h, tag)) throw new Panic(`matchTag: no handler for _tag ${tag}`)
  return call(h[tag]!, r.error)
})

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
