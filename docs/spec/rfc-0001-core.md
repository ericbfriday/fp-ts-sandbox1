# RFC 0001 — Core spec: Result shape, error taxonomy, wire envelope, Problem Details

Status: **Accepted** (Phase 0 deliverable, Design Report §3 + IDEA.md §4). Scope names in code: `@friday-friday/*`.

## 1. Result shape

```ts
export interface Ok<out T> { readonly ok: true; readonly value: T }
export interface Err<out E> { readonly ok: false; readonly error: E }
export type Result<T, E = never> = Ok<T> | Err<E>;
export type AsyncResult<T, E = never> = Promise<Result<T, E>>;
```

- Interfaces (not object type aliases) with `out` variance annotations: cached identity, cheaper checks, covariant in both params.
- No classes, no prototypes: Results survive `structuredClone`, RSC payloads, `"use cache"`, tRPC transformers, `JSON.stringify` unchanged.
- `E` defaults to `never`; error unions grow by `|` only.
- Discriminant is `ok: boolean` — cheapest narrowing (`if (r.ok)`), no clash with `status` in adapter code.

## 2. Error taxonomy

Errors are **plain data** with a literal `_tag`, built by a factory with a structural guard — never `instanceof`:

```ts
export interface TaggedError<Tag extends string> { readonly _tag: Tag; readonly message?: string }
export interface ErrorFactory<Tag extends string, P extends object> {
  (props: P & { message?: string; cause?: unknown }): TaggedError<Tag> & Readonly<P>;
  readonly tag: Tag;
  is(u: unknown): u is TaggedError<Tag> & Readonly<P>;
}
export function taggedError<const Tag extends string>(tag: Tag): <P extends object = {}>() => ErrorFactory<Tag, P>;
```

Convention-fixed vocabulary:

| Layer | Tags |
|---|---|
| Domain (in `E`) | `NotFound`, `Conflict`, `Forbidden`, `Unauthenticated`, `ValidationFailure` |
| Infrastructure (in `E`) | `NetworkError`, `Timeout`, `DbUnavailable` |
| Defects (never in `E`) | thrown `Panic extends Error`; `InternalDefect` exists only at the wire |

Rules:
- `cause` stays server-side; stripped (or replaced by a digest) before any boundary.
- `toThrowable(e)` produces a real `Error` (`name = _tag`, data attached) for Error Boundaries / `catchError` paths.
- No Option type: `T | undefined` + `fromNullable(x, () => NotFound(...))`.

## 3. Defects and triage

Defects are thrown, not values. Callbacks that throw inside `map`/`andThen` rethrow as `Panic` with the original `cause`. Boundary triage is mandatory and explicit:

```ts
interface TryOptions<E> {
  readonly catch: (cause: unknown) => E | undefined; // undefined => defect, rethrow
  readonly rethrow?: (cause: unknown) => void;       // framework sentinels first
  readonly signal?: AbortSignal;
}
function tryAsync<T, E>(fn: (signal?: AbortSignal) => Promise<T>, opts: TryOptions<E>): AsyncResult<T, E>;
function trySync<T, E>(fn: () => T, opts: Omit<TryOptions<E>, "signal">): Result<T, E>;
```

Every lane (sync combinators, `/async`, `/gen`) converts through one exported, idempotent `toPanic(cause): Panic`: a foreign throw or rejection becomes `Panic` with the original as `cause`, and an existing `Panic` passes through as the same instance. Adapters and bridges reuse it after rethrowing their framework sentinels. A `Panic` has a short, bounded message that never prints the thrown value's data (a thrown config object must not leak its secrets into logs): a string as-is, other primitives via `String()`, an object by its string `_tag`/`message` only (`name` standing in for a missing message; a tagged error reads `Tag: message`, an `Error` its message), else `"Non-Error thrown"`; capped at 200 chars, the full value stays on `cause`. `toPanic` and the message are total: a value that throws when inspected (revoked Proxy, throwing getter) gives `"Unprintable thrown value"`.

No global rethrow registry. Adapters export pre-bound variants (`@friday-friday/next`'s `tryAsync` calls `unstable_rethrow` first, walking `cause` to depth 5).

## 4. Combinators

Pure, pipeable, **dual** (data-first/data-last via `arguments.length`), separate named exports with `/*#__PURE__*/`:
`map, mapErr, andThen, orElse, tap, tapErr, unwrapOr, match, matchTag, fromNullable, all, partition`.
`pipe` = explicit overloads to 16 arity; `flow` to 12. No HKTs, no recursive pipe types.
`/async` subpath: `mapAsync, andThenAsync, allAsync, retry, timeout, mapConcurrent` — all accept `{ signal }`.

> **Errata (2026-11-16, PR #12 review):** cancellation-capable helpers (`allAsync`, `mapConcurrent`, `retry`, `timeout`, `tryAsync`) take `{ signal }` and FORWARD it into the user callback/thunk so underlying work can observe cancellation. The pure duals (`mapAsync`, `andThenAsync`, `orElseAsync`, `tapAsync`, `tapErrAsync`) perform no cancellation of their own — callers bind their signal in the callback closure; they extend the named inventory, mirroring the sync surface. See `docs/decisions/2026-11-16-async-signal-handling.md`.
`/gen` subpath (opt-in): `gen`, `genAsync` with a `$()` wrapper so Results stay pure data.

## 5. Wire envelope

1. Results cross boundaries as plain JSON: `{ ok, value }` / `{ ok: false, error: { _tag, ...props } }`.
2. Contract tests: `JSON.parse(JSON.stringify(r))` deep-equals `r`; `structuredClone(r)` deep-equals `r` — for every public constructor and combinator output.
3. `cause` never crosses a boundary. Sanitizers drop it and non-JSON-safe props before serialization.
4. Per-boundary mapping summary (normative for adapters):

| Boundary | Err becomes |
|---|---|
| Next.js Server Action | returned Result via `useActionState` (`{ ok: null }` idle state); sentinels rethrown, never swallowed |
| Next.js Route Handler | `Response.json(value)` or `application/problem+json` via `toResponse` |
| TanStack Query | thrown plain `E` in `queryFn` (`Ok(undefined)` → `null`) |
| tRPC | `TRPCError` on the error channel, `data.fl = sanitize(e)` via `errorFormatter` |
| TanStack Start | returned as data (`Err(ValidationFailure)` with structured issues); only defects throw |
| Better Auth | normalized `Result<T, AuthError>` from throw (`isAPIError`) and `{ data, error }` tuple |

## 6. Problem Details mapping (RFC 9457)

`problem(e, status)` emits `application/problem+json`:

```json
{ "type": "https://friday-friday.dev/errors/<_tag-kebab>",
  "title": "<human title for tag>", "status": <status>,
  "detail": "<message?>", "tag": "<_tag>", ...safeProps }
```

- `tag` is the reconstruction key for clients (`HttpError` parses it back into the tagged error — lossless Hono↔client round-trips).
- `safeProps` = allowlisted JSON-safe props of the error; `cause` and anything non-JSON-safe is dropped.
- Default tag→status suggestions (adapters take explicit status maps; these are only fallbacks): `NotFound→404`, `Forbidden→403`, `Unauthenticated→401`, `Conflict→409`, `ValidationFailure→422`, everything else→`500` as `InternalDefect`.

## 7. Naming

Code uses `@friday-friday/*` (`@friday-friday/core`, `/schema`, `/next`, …). The report's `@fl/*` and "Plainfp" remain placeholders; run `npm view` before any publish.
