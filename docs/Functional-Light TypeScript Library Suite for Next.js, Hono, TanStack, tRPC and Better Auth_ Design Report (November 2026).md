# Design: A "Functional-Light" TypeScript Library Suite for Next.js, Hono, TanStack, tRPC and Better Auth (November 2026)

Build a small, zero-dependency core with a plain-object `Result` and plain-object tagged errors, plus thin adapters for each framework. The adapters are where the suite earns its keep: Result libraries already exist, but none of them absorbs the framework traps that make errors-as-values awkward in a real stack. Those traps are Next.js sentinel throws, TanStack Query's throw-to-error contract, TanStack Start's flattened validation errors, Better Auth's mixed throw-and-tuple API, and Hono's RPC status inference.

## TL;DR

- **Build a tiny core and spend the effort on adapters.** The core is a plain-object `Result` (`{ ok: true, value } | { ok: false, error }`), JSON-safe `_tag` errors, pipeable dual functions and `Promise<Result>` for async. Prior art now covers the core well: byethrow 0.11 (plain objects), better-result 3 (class-based, with `Result.codec` for the wire), unthrown (defect channel plus oRPC, Drizzle and Effect bridges) and Effect 4.0 (stable since 30 Sep 2026, LTS to Sept 2029). What none of them covers is the framework integration.
- **The MVP is `core` + `schema` + `next`, followed immediately by `query`** (TanStack Query). Those packages fix the problems you hit daily in an Nx/Next.js monorepo:
  - redirect()/notFound() swallowed by try/catch. The Next.js API reference still says `unstable_rethrow` "is currently unstable and subject to change".
  - Server Action state for `useActionState`.
  - `catchError`, stable since Next.js 16.3.
  - Making `Err` become `query.error`. TanStack Query's docs say "the query function must throw or return a rejected Promise".
- **Treat several version facts as moving targets and pin peer ranges conservatively.** TanStack Start renamed `.inputValidator()` to `.validator()` with no alias.\[1\]\[2\] oRPC v2 (beta) removed typed *returned* errors. Hono 5 is at RC. TypeScript 7.0 (Go) shipped without a stable compiler API, and 7.1 restores it (beta 20 Oct 2026; stable planned for 24 Nov). Better Auth is on 1.7.25 (14 Nov 2026).\[3\] Several claims in the attached documents could not be verified; they are flagged below.

## Key Findings

1. **The ecosystem gap is the boundary, not the monad.** Each framework has its own error-transport contract:
   - Next.js throws sentinels.\[4\]
   - TanStack Query needs a throw.\[5\]
   - tRPC funnels errors through `TRPCError` and `errorFormatter`.\[6\]
   - TanStack Start serializes validation issues into `error.message` (issue #6428).\[7\]
   - Better Auth throws `APIError` on the server but returns `{ data, error }` on the client.\[8\]\[9\]

   A suite whose differentiator is "one Result shape, correct behavior at every boundary" fills a real gap.
2. **Plain-object Results are the right wire format, but the attached blueprint misdescribed better-result.** better-result's `Ok`/`Err` are *classes*.\[10\] In v3 it removed `Result.serialize`/`deserialize`/`hydrate` and added Standard-Schema-validated `Result.codec` envelopes.\[11\] byethrow is the plain-object reference (`{ type: 'Success', value }`).\[12\]\[13\] unthrown is class-based with a `Symbol.for` brand and a third `Defect` variant.\[14\]
3. **Standard Schema is the right validation contract, and it has grown.** `@standard-schema/spec` 1.1.0 now includes `StandardTypedV1` and `StandardJSONSchemaV1` (JSON Schema conversion).\[15\]\[16\]\[17\] That lets the schema package emit OpenAPI/JSON Schema without vendor adapters.\[18\]
4. **Effect should stay an optional bridge.** Effect 4.0 is stable, dependency-free and has LTS. It is also much smaller: Effect's 4.0 release post puts a minimal program using Effect, Stream and Schema at 7.1 kB against 35.6 kB in 3.x, about 5× smaller (the v4 migration guide gives 6.3 kB).
   - The Effect team's post "Effect 4.0: The First Week" (8 Oct 2026) admitted that "some modules that were intended to ship as unstable went out without a tag". 4.0.2 then tagged every export.
   - The 4.0.0 changelog states that "APIs tagged @stability unstable may have breaking changes in minor releases". Modules tagged that way include http, rpc, schema and sql.
   - So bridge only stable-tagged modules (`Exit`, `Cause`, the core `Effect` run functions).
5. **TypeScript 7 changes your *tooling* risk more than your type design.** Microsoft's TypeScript 7.0 Beta announcement says the Go codebase's "type-checking logic is structurally identical to TypeScript 6.0." So type-level design constraints (no HKTs, instantiation-depth limits) carry over. Tools that rely on the programmatic compiler API (tsd, ts-morph-based codemods, some typecheck runners) could not run on 7.0 and need 7.1's new `typescript/sync`/`typescript/async` entry points.\[19\]\[20\]\[21\]

---

## 1. Verified ecosystem state (as of 16 Nov 2026)

Legend: **V** = verified from a primary source (official docs, blog, GitHub release or issue). **S** = secondary source only (tracker, blog, third-party PR). **U** = not verified this pass; carried over from the attached documents.

| Library | Current state | Status | Design implication |
|---|---|---|---|
| Next.js | 16.4 released 6 Oct 2026 (React 19.3 features, Cache Components recommended and default in `create-next-app`). Trackers list 16.4.3 (23 Oct) and later patches. Monthly security releases.\[22\]\[23\]\[24\] | V (blog), S (patch numbers) | Peer `next >=16.3 <18`; test against 17 canary when it appears. |
| `catchError` (`next/error`) | Stable since v16.3.0 (was `unstable_catchError` in 16.2). Handles Next.js control-flow errors, so they aren't caught by your boundary.\[25\]\[26\]\[27\]\[28\] | V | `@fl/next/client` re-exports it with Result-aware fallbacks. |
| `unstable_rethrow` (`next/navigation`) | Still documented as "currently unstable… not recommended for production". Call it at the top of `catch`. Covers `notFound()`, `redirect()`, `permanentRedirect()`, and request-time APIs under PPR.\[4\] | V | Every catching helper in the Next adapter must call it first. |
| Cache Components | Recommended for every app in 16.4; slated as the default in Next.js 17.\[29\] | V/S | Result values returned from `"use cache"` functions must be serializable: another reason for plain objects. |
| Effect | 4.0 stable, published 30 Sep 2026 (GitHub release timestamp 1 Oct 01:47 UTC); 4.0.1/4.0.2 on 8 Oct. Single version across `@effect/*`. Platform, RPC, cluster and others merged into `effect`. 4.x fixes until Sept 2029.\[30\]\[31\] | V | `@fl/effect` peer `effect ^4.0`. |
| TypeScript | 6.0 (23 Mar 2026) is the last JS-based compiler. 7.0 (Go) GA 8 Jul 2026, with full builds 8–12× faster per the TypeScript team (Slack reported CI type-checking falling from about 7.5 to 1.25 minutes) and no stable programmatic API. 7.1 Beta 20 Oct 2026 adds `typescript/sync`, `typescript/async`, `typescript/fs`, `typescript/ast`, content mappers and stable `es2026`. Iteration plan targets RC ~10 Nov and stable 24 Nov. | V (devblogs), S (dates of RC/stable) | CI matrix: 6.0, 7.0, 7.1. |
| Hono | Latest stable v4.13.16 (1 Nov 2026). 5.0.0-rc.1 published 10 Oct 2026. v4.10.0 made middleware responses inferable in the `hc` client. `@hono/standard-validator` (`sValidator`) available since v4.7.\[32\]\[33\]\[34\]\[35\] | V (releases), S (RC details) | Peer `hono ^4.10 \|\| ^5.0.0-0`. Hono 5 changes `onError` composition (S).\[36\] |
| tRPC | v11 (11.18.0 per secondary sources). `.input()`/`.output()` accept Standard Schema. `errorFormatter` output is inferred to the client. `StandardSchemaV1Error` exported.\[6\]\[37\]\[38\] | V (docs/PR), S (patch) | Zod-only `errorFormatter` checks miss Valibot/ArkType failures (S), so the adapter formats from Standard Schema issues.\[39\] |
| TanStack Query | v5 (npm shows 5.107.x). `retry: (failureCount, error) => boolean`. `throwOnError: boolean \| (error, query) => boolean`. "The query function must throw or return a rejected Promise". "Queries that resolve to undefined will be treated as failed."\[5\]\[40\] | V (docs), S (version) | `toQueryFn` must throw on `Err` and map `Ok(undefined)` to `null`. |
| TanStack Start | `createServerFn().validator(...)`. `.inputValidator()` was removed in `@tanstack/start-client-core` 1.170.36 with no alias (react-start ≥1.169.0). Issue #6428: Standard Schema issues are JSON-stringified into `error.message`. Function middleware types require returning `next()`. Issue #7507: validator skipped on direct calls in tests.\[2\]\[7\]\[41\] | V (docs, issues), S (exact version floor) | Adapter returns validation failures as data and pins `>=1.169`. |
| TanStack Form | v1.33.x. Standard Schema validators accepted directly (Zod ≥3.24, Valibot ≥1.0, ArkType ≥2.1.20, Yup ≥1.7). v2 alpha moves to array validators `[{ run, triggers }]`. `ServerValidateError` `instanceof` fails across duplicate module copies (discussion #1928).\[42\]\[43\]\[44\] | V/S | Adapter uses structural checks only. |
| TanStack Store | 0.11: `useStore` deprecated in favor of `useSelector`.\[45\] | V | Never use `useStore` in adapters. |
| Better Auth | 1.7.25 (14 Nov 2026); 1.6.x maintenance line (1.6.34, 1 Nov). Server `auth.api.*` throws `APIError`; check it with `isAPIError` from `better-auth/api` rather than `instanceof`. Client returns `{ data, error }`. `returnHeaders` and `asResponse` options. Error bodies carry a machine-readable `code` since 1.5.\[3\]\[8\]\[9\]\[46\] | V | Peer `better-auth ^1.6 \|\| ^1.7`. |
| Better Auth Effect | Issue #7338 exists. A maintainer said "our team don't have a plan right now". Effect integration-guide PR #11566 unmerged. Community package `effectful-better-auth` exists.\[47\]\[48\]\[49\] | V (current open/closed status **U**) | No official Effect package. Bridge via the suite. |
| Standard Schema | `@standard-schema/spec` 1.1.0: `StandardSchemaV1`, `StandardTypedV1`, `StandardJSONSchemaV1` (`~standard.jsonSchema.input/output({ target })`).\[15\]\[16\]\[17\] | V | `@fl/schema` builds on 1.1. |
| better-result | v3.0 (Aug 2026): `Result.codec` replaces serialize/deserialize/hydrate. `TaggedError("X")<Props>` without the trailing call. Tagged errors are `yield*`-able in `Result.gen`. `Ok`/`Err` are classes. Ships agent skills.\[10\]\[11\]\[50\] | V | Interop via its codec envelope. |
| @praha/byethrow | 0.11.1. Plain objects `{ type: 'Success' \| 'Failure' }`. `ResultAsync` = `Promise<Result>`. `Result.pipe`, `bind`, `collect`. Tree-shakable.\[12\]\[51\]\[52\] | V | Closest design relative. Converters, not a dependency. |
| unthrown | v5.11. Three-variant Result (`Ok`/`Err`/`Defect`). Forces triage at `fromPromise`. Satellites: `@unthrown/effect`, `/neverthrow`, `/drizzle`, `/orpc`, `/standard-schema`, `/oxlint`. Its own issue tracker concedes that TS does not force callers to consume Results.\[14\]\[53\]\[54\]\[55\] | V | Strongest prior art for the defect concept and lint plugin. |
| oRPC | v2 beta (2.0.0-beta.50). PR #1987 (6 Sep 2026) removed typesafe *returned* `ORPCError`s and the `inferable` flag. Typed errors come only from codes declared with `.errors({...})`. `isDefinedError`. Official Effect integration.\[56\]\[57\]\[58\] | V | oRPC already has a dual error channel. Ship an interop doc, not a package. |
| neverthrow, fp-ts, ts-pattern 5.9, Remeda 2.50, es-toolkit 1.52, download counts | Claimed in Document 1. | **U** | Defer to these libraries rather than re-implementing them. Re-check versions before publishing peer ranges. |
| next-safe-action, `@next-safe-action/adapter-better-auth`, result-rpc, hono-problem-details | Claimed in Document 2. | **U** | Treat as prior art to study, not as dependencies. |

---

## 2. Build, wrap, or defer

| Concern | Decision | Rationale |
|---|---|---|
| Result type and combinators | **Build** (tiny) | No existing library is simultaneously plain-object, 1.x-stable and paired with framework adapters. byethrow is pre-1.0; better-result and unthrown are class-based. |
| Exhaustive matching | **Build** `matchTag` only; **defer** to ts-pattern | A 20-line `_tag` switch covers 90% of uses. ts-pattern already matches discriminated unions, including Results. |
| Collections (`groupBy`, `chunk`…) | **Defer** to Remeda / es-toolkit | Re-implementing them buys nothing. Document Remeda's data-last style inside `pipe`. |
| Schema validation | **Wrap** Standard Schema | Never take a hard dependency on Zod, Valibot or ArkType. |
| Do-notation | **Build** a minimal `gen` (sync + async) | Opt-in ergonomics, isolated in its own subpath so its cost doesn't hit everyone. |
| Effects runtime, DI, fibers | **Defer** to Effect 4 via `@fl/effect` | Functional-light means no runtime. |
| HTTP client | **Build** a thin `fetchResult` | Small; the value is mapping HTTP, network, decode and timeout failures to tags. |
| DB error mapping | **Build** small mappers | Drizzle/Postgres SQLSTATE and Prisma codes. Note that `@unthrown/drizzle` exists.\[53\] |
| Server Actions DX | **Build**, studying next-safe-action | The integrated `useActionState` + `unstable_rethrow` + Result story isn't covered end-to-end. |
| oRPC | **Document only** | v2's `.errors()` and `isDefinedError` already provide a dual channel.\[57\]\[59\] A 30-line recipe suffices. |

---

## 3. Core primitive design (`@fl/core`)

### 3.1 Result shape: why `ok: boolean`

| Shape | Pros | Cons |
|---|---|---|
| `{ status: "ok" \| "err" }` (Document 2) | Readable, string literal | Extra word; `status` collides with HTTP status in adapter code (`res.status`, `error.status` in Better Auth) |
| `{ _tag: "Ok" \| "Err" }` | Effect/ts-pattern idiom | Ambiguous when errors also carry `_tag`. Matching `{ _tag: "NotFound" }` vs `{ _tag: "Err" }` in nested patterns is error-prone for humans and agents. |
| `{ type: "Success" \| "Failure" }` (byethrow) | Explicit | `type` is a common domain field |
| **`{ ok: true \| false }`** | Cheapest narrowing (`if (r.ok)`), smallest JSON, mirrors `Response.ok` and Zod's `success` idiom, no clash with error `_tag` | Booleans can't extend to a third variant. That's intentional: defects are not values (see 3.3). |

```ts
// @fl/core — every export has an explicit type so the package passes isolatedDeclarations
export interface Ok<out T> { readonly ok: true; readonly value: T }
export interface Err<out E> { readonly ok: false; readonly error: E }
export type Result<T, E = never> = Ok<T> | Err<E>;
export type AsyncResult<T, E = never> = Promise<Result<T, E>>;

export const ok: <T>(value: T) => Ok<T> = (value) => ({ ok: true, value });
export const err: <E>(error: E) => Err<E> = (error) => ({ ok: false, error });
export const isResult: (u: unknown) => u is Result<unknown, unknown> = (u) =>
  typeof u === "object" && u !== null && typeof (u as any).ok === "boolean" &&
  ((u as any).ok ? "value" in u : "error" in u);
```

The type decisions behind this:

- **Interfaces rather than type-alias objects** give better error messages and cached identity. The `out` variance annotations make `Result<T, E>` covariant in both parameters, so `Result<Cat, NotFound>` is assignable to `Result<Animal, NotFound | Forbidden>`. They also let the checker skip structural variance probing, which is cheaper.
- **No class and no prototype.** Results survive `structuredClone`, RSC payloads, `"use cache"`, tRPC transformers, TanStack Start serialization and `JSON.stringify` unchanged.
- **Erasable syntax only.** No `enum`, `namespace` or parameter properties, so the source runs under `erasableSyntaxOnly` and Node/Bun/Deno type stripping.
- **The error type defaults to `never`,** so `ok(1)` is `Result<number, never>` and unions widen naturally through `andThen`.

### 3.2 Tagged errors: plain data, not `Error` subclasses

Class-based tagged errors (better-result, unthrown, Effect `Data.TaggedError`) lose their prototype on the wire. They also hit the duplicate-module `instanceof` trap: Better Auth's docs warn about it for `APIError`, and TanStack Form shows it for `ServerValidateError`.\[9\]\[44\] The suite's errors are therefore plain objects with a literal `_tag`, created by a factory that also provides a structural guard.

```ts
export interface TaggedError<Tag extends string> { readonly _tag: Tag; readonly message?: string }

export interface ErrorFactory<Tag extends string, P extends object> {
  (props: P & { message?: string; cause?: unknown }): TaggedError<Tag> & Readonly<P>;
  readonly tag: Tag;
  is(u: unknown): u is TaggedError<Tag> & Readonly<P>;
}

export function taggedError<const Tag extends string>(tag: Tag): <P extends object = {}>() => ErrorFactory<Tag, P>;

// Usage (explicit annotation keeps isolatedDeclarations happy and documents the contract):
export const NotFound: ErrorFactory<"NotFound", { resource: string; id: string }> =
  taggedError("NotFound")<{ resource: string; id: string }>();
export type NotFound = ReturnType<typeof NotFound>;
```

The rules for these errors:

- **`cause` is kept server-side but never serialized.** Adapters strip it, or replace it with a digest, before crossing a boundary.
- **`toThrowable(e)` exists for the few places that need a real `Error`,** such as Error Boundaries and logging stacks. It returns an `Error` with `name = _tag` and the data attached.
- **The error taxonomy is fixed by convention.**
  - Domain errors are `_tag` values in `E`: `NotFound`, `Conflict`, `Forbidden`, `ValidationFailure`.
  - Infrastructure errors are mapped tags: `NetworkError`, `Timeout`, `DbUnavailable`.
  - Defects are never in `E`.

### 3.3 Defects: thrown, then sanitized at the edge

The decision is to keep defects as JavaScript exceptions (`Panic extends Error`) and *not* add a third union member.

- **Why:** a third variant (unthrown's `Defect`) forces every consumer, adapter and wire format to handle three states.\[14\]\[60\] It also breaks the `if (r.ok)` narrowing that makes Results cheap.
- **How defects are handled:**
  - Callbacks passed to `map`/`andThen` that throw are rethrown as `Panic` with the original `cause`.
  - Every adapter's outermost layer converts unknown throws into a sanitized `InternalDefect` response (HTTP 500 Problem Details, `INTERNAL_SERVER_ERROR` in tRPC, a generic action state in Next.js) and reports the original to OpenTelemetry.
- **Triage is mandatory at boundaries,** borrowing unthrown's best idea:

```ts
export interface TryOptions<E> {
  /** Map an unknown throw to a domain error, or return `undefined` to treat it as a defect (rethrow). */
  readonly catch: (cause: unknown) => E | undefined;
  /** Framework sentinels to rethrow before mapping (e.g. Next.js redirect/notFound). */
  readonly rethrow?: (cause: unknown) => void;
  readonly signal?: AbortSignal;
}
export function tryAsync<T, E>(fn: (signal?: AbortSignal) => Promise<T>, opts: TryOptions<E>): AsyncResult<T, E>;
export function trySync<T, E>(fn: () => T, opts: Omit<TryOptions<E>, "signal">): Result<T, E>;
```

There is no global "rethrow registry". A mutable module-level registry breaks when the package is duplicated across server and client bundles, which is exactly the RSC situation. Adapters instead export pre-bound `tryAsync` variants.

### 3.4 Combinators: pure, pipeable, dual

```ts
type Dual2<A, B, R> = { (b: B): (a: A) => R; (a: A, b: B): R };

export const map: {
  <T, U>(f: (t: T) => U): <E>(r: Result<T, E>) => Result<U, E>;
  <T, E, U>(r: Result<T, E>, f: (t: T) => U): Result<U, E>;
};
export const mapErr: { /* same shape over E */ };
export const andThen: {
  <T, U, E2>(f: (t: T) => Result<U, E2>): <E>(r: Result<T, E>) => Result<U, E | E2>;
  <T, E, U, E2>(r: Result<T, E>, f: (t: T) => Result<U, E2>): Result<U, E | E2>;
};
export const orElse, tap, tapErr, unwrapOr, match, matchTag, fromNullable, all, partition;

// Async lives in a separate subpath; it accepts Result | Promise<Result> and always returns Promise<Result>.
// "@fl/core/async": mapAsync, andThenAsync, allAsync (concurrent, input-order error selection), retry, timeout, mapConcurrent.

export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
// … explicit overloads up to 16 arity. No recursive "pipe of N" types.
export function flow<A extends readonly unknown[], B>(ab: (...a: A) => B): (...a: A) => B;
// … overloads to 12.
```

The type-system choices here:

- **No HKT encoding.** Every combinator is monomorphic over `Result`. That gives the suite neither fp-ts `URItoKind` nor Effect `TypeLambda` machinery, which means faster checks, better hover text and fewer TS2589 "excessively deep" failures. TS 7 preserves 6.0 semantics, so the limits are unchanged (and 7.1 Beta's notes flag stricter generic subtyping, S).\[61\]
- **Overloads over recursive conditional types for `pipe`/`flow`.** Overload resolution is linear and never recursive, so pipes cannot trigger instantiation-depth errors.
- **Error unions grow by `|` only.** There is no `Exclude`-heavy narrowing in hot paths. `catchTag("NotFound", f)` uses `Exclude<E, { _tag: "NotFound" }>` once per call, which is bounded.
- **The dual API uses `arguments.length`, not runtime type sniffing** (better-result and Effect do the same). Each function is a separate named export with `/*#__PURE__*/` construction, so bundlers drop unused ones. That is not possible with neverthrow-style instance methods.

### 3.5 Generators (`@fl/core/gen`)

```ts
export function gen<Y extends Err<any>, T>(f: () => Generator<Y, T, any>): Result<T, Y extends Err<infer E> ? E : never>;
export function genAsync<Y extends Err<any>, T>(f: () => AsyncGenerator<Y, T, any>): AsyncResult<T, Y extends Err<infer E> ? E : never>;
// Results are made yieldable via a tiny helper: `const user = yield* $(findUser(id))`
```

Plain objects can't carry `[Symbol.iterator]` without becoming non-JSON-clean. So `gen` uses a `$()` wrapper that returns a one-shot iterator, which keeps Results pure data. Generators cost stack-trace quality and some inference time, so recommend them only for flows of four or more steps. Plain `async`/`await` with early returns stays first-class:

```ts
const u = await findUser(id);
if (!u.ok) return u;
```

### 3.6 Option, brands, context, resources, observability

- **Option: none.** Use `T | undefined`, with `fromNullable(x, () => NotFound(...))` to lift into Result. An Option type adds a second container that agents and juniors misuse.
- **Brands** use a phantom type with no runtime cost:

```ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
```

  `@fl/schema` provides `branded(schema, "UserId")`, which validates and then brands.
- **Dependency injection without a runtime.** Functions take an explicit `deps` object as the first argument (`(deps: { db: Db; clock: Clock }) => (input) => AsyncResult<…>`). Adapters pull `deps` from tRPC `ctx`, Hono `c.var` or TanStack Start middleware context. No Layer graph and no `AsyncLocalStorage` requirement.
- **Cancellation and resource safety.**
  - Every async helper accepts `{ signal }`. `timeout(ms)` composes `AbortSignal.timeout` with `AbortSignal.any` and yields `Err(Timeout)`.
  - `retry(fn, { times, delay: "exponential", while: (e) => e._tag !== "Forbidden", signal })` retries on `Err` *values*, never on defects.
  - `bracket`-style helpers use `await using` and `Symbol.asyncDispose` where the runtime supports them, with a `try/finally` fallback. Runtime support for explicit resource management varies by engine and version and was not verified per runtime this pass, so feature-detect it.
- **Observability.** `@fl/otel` (peer `@opentelemetry/api`) provides `traced(name, fn)`. On `Err` it sets span status `ERROR` and attributes `fl.error.tag=<_tag>` without recording an exception. Defects are recorded as exceptions. Expected errors and bugs therefore separate cleanly in dashboards.

---

## 4. Package suite and boundaries

Working scope is `@fl/*` (see §7 for names).

| Package | Contents | Runtime deps | Peers | Entry conditions |
|---|---|---|---|---|
| `@fl/core` | Result, tagged errors, pipe/flow, dual combinators; `/async`, `/gen`, `/interop` (neverthrow, byethrow, better-result codec envelope, Effect Exit, Better Auth tuple, Standard Schema result) | none | none | `default` only |
| `@fl/schema` | `parse`/`parseAsync` → `Result<T, ValidationFailure>`, issue flatteners (`toFieldErrors`, `toFormErrors`), `branded`, `toJsonSchema` via `StandardJSONSchemaV1` | `@standard-schema/spec` (types only) | none | `default` |
| `@fl/next` | `action`, `loader` helpers, `tryAsync` with `unstable_rethrow`, `toResponse`, `catchError` fallbacks | none | `next >=16.3`, `react >=19.2` | `react-server`, `default`; `/client` subpath |
| `@fl/query` | `toQueryFn`, `toMutationFn`, `resultQueryOptions`, `retryUnless`, `Register` typing | none | `@tanstack/query-core ^5` | `default` |
| `@fl/tanstack-start` | `resultServerFn`, Standard Schema validator wrapper, serialization adapter, router loader helpers (`orNotFound`, `orRedirect`), Form issue mappers | none | `@tanstack/react-start >=1.169`, `@tanstack/react-router`, `@tanstack/react-form` (optional) | `default` |
| `@fl/hono` | `respond`, `problem`, `sv` (sValidator hook), `onErrorHandler`, `requireSession` middleware factory | none | `hono ^4.10 \|\| ^5.0.0-0`, `@hono/standard-validator` | `workerd`, `default` |
| `@fl/trpc` | `resultProcedure`, `errorFormatter`, `fromTRPC` client reconstruction | none | `@trpc/server ^11`, `@trpc/client ^11` | `default` |
| `@fl/better-auth` | `authCall`, `fromAuthTuple`, `requireSession`/`requireRole`, `beforeDbHook`, `hookRouter` | none | `better-auth ^1.6 \|\| ^1.7` | `default` |
| `@fl/http` | `fetchResult` with schema decode, timeout, retry | none | none | `default` |
| `@fl/db` | `mapPgError`, `mapPrismaError`, `transaction` helpers | none | optional `drizzle-orm`, `@prisma/client` | `default` |
| `@fl/env` | `parseEnv(schema, source)` → Result; fail-fast `loadEnv` | none | none | `default` |
| `@fl/effect` | `fromExit`, `runResult`, `toEffect` | none | `effect ^4.0` | `default` |
| `@fl/otel` | `traced`, span helpers | none | `@opentelemetry/api ^1` | `default` |
| `@fl/eslint-plugin` / `@fl/oxlint-plugin` | `must-use-result`, `no-try-around-redirect`, `no-instanceof-tagged-error` | — | eslint / oxlint | — |

Boundary rules:

- `core` imports nothing.
- `schema` imports only `core`.
- Adapters import `core` and `schema` and their framework's peer packages, and never each other. The one exception is `@fl/tanstack-start` re-using `@fl/query`, which is optional.

---

## 5. Integration adapters

### 5.1 Next.js (`@fl/next`)

**Traps the adapter absorbs:**

1. `redirect()`, `notFound()`, `forbidden()`, `unauthorized()` and request-time APIs (under PPR) throw sentinels, and any try/catch swallows them. The official fix is `unstable_rethrow` at the top of `catch`, and that API is still marked unstable.\[4\]\[62\]
2. Document 2 claims `unstable_rethrow` doesn't inspect `error.cause` (U). The adapter defensively walks the `cause` chain anyway (bounded at depth 5) before mapping.
3. Server Action return values must be serializable, which plain Results are.
4. `catchError` is stable only from 16.3.\[26\]\[27\]\[28\]

```ts
// @fl/next (react-server condition)
import { unstable_rethrow } from "next/navigation";
export const nextRethrow = (cause: unknown): void => {
  for (let c: unknown = cause, i = 0; c && i < 5; c = (c as any)?.cause, i++) unstable_rethrow(c);
};
export const tryAsync = <T, E>(fn: () => Promise<T>, catchFn: (u: unknown) => E | undefined): AsyncResult<T, E> =>
  core.tryAsync(fn, { catch: catchFn, rethrow: nextRethrow });

export type ActionState<T, E> = { ok: null } | Result<T, E>;   // `{ ok: null }` = idle initial state

export function action<S extends StandardSchemaV1, T, E extends TaggedError<string>>(
  schema: S,
  handler: (input: StandardSchemaV1.InferOutput<S>) => AsyncResult<T, E>,
  opts?: { onDefect?: (cause: unknown) => void },
): (prev: ActionState<T, E | ValidationFailure | InternalDefect>, formData: FormData)
   => Promise<ActionState<T, E | ValidationFailure | InternalDefect>>;
```

```tsx
// app/settings/actions.ts
"use server";
export const updateProfile = action(ProfileSchema, async (input) => {
  const r = await profiles.update(input);
  if (r.ok) redirect("/settings?saved=1");      // sentinel thrown *outside* any catch inside the adapter
  return r;
});

// app/settings/form.tsx
"use client";
const [state, formAction, pending] = useActionState(updateProfile, { ok: null });
const fieldErrors = state.ok === false && state.error._tag === "ValidationFailure" ? toFieldErrors(state.error) : {};
```

Other Next.js surfaces:

- **RSC loaders:**
  - `orNotFound(r)` returns the value, or calls `notFound()` for `_tag: "NotFound"`.
  - `orForbidden(r)` calls `forbidden()` for `Forbidden`. That API sits behind `experimental.authInterrupts` (S; verify the flag before relying on it).
  - `orThrow(r)` throws `toThrowable(e)` for `error.tsx`/`catchError`.
- **Route Handlers:** `toResponse(r, { NotFound: 404, Conflict: 409 })` returns `Response.json(value)` or `application/problem+json`.
- **Client (`@fl/next/client`):** `resultBoundary(Fallback)` wraps `catchError` and decodes the tagged data attached by `toThrowable`. Note that production Next.js redacts server error messages to a `digest` (behavior from prior Next.js versions; not re-verified), so domain detail for server-rendered errors must come via returned Results, not thrown ones.
- **Exports:** the root entry resolves `react-server` to server helpers and `default` to a stub that throws a clear "server-only" error. `/client` imports `"client-only"`.

### 5.2 Hono (`@fl/hono`)

**Traps the adapter absorbs:**

1. The `hc` client infers responses only from chained routes and literal status codes.\[63\]\[64\] Returning `c.json(x, status as number)` collapses the union.
2. Large `AppType`s can hit instantiation-depth limits and silently widen.\[64\]
3. `HTTPException` is how middleware short-circuits. Document 2's claim that headers are lost in `onError` is U, so treat it as a test case.
4. Hono 5 RC changes `onError` composition and `c.json(undefined)` behavior (S).\[36\]

```ts
type StatusMap<E extends TaggedError<string>> = { readonly [K in E["_tag"]]: ContentfulStatusCode };

export function respond<C extends Context, T, E extends TaggedError<string>, const M extends StatusMap<E>>(
  c: C, r: Result<T, E>, statuses: M,
): Response & TypedResponse<T, 200, "json"> | Response & TypedResponse<Problem<E>, M[E["_tag"]], "json">;

app.get("/users/:id", sv("param", IdParam), async (c) =>
  respond(c, await users.find(c.req.valid("param").id), { NotFound: 404, Forbidden: 403 } as const));

// client: res.status is 200 | 404 | 403, and `await res.json()` narrows per status
```

- **`problem(e, status)`** emits RFC 9457 `{ type, title, status, detail, tag, ...safeProps }`. The `tag` field lets the client reconstruct the tagged error.
- **`sv(target, schema)`** wraps `sValidator` with a hook that returns a 422 Problem built from Standard Schema issues.
- **`onErrorHandler({ report })`** maps `HTTPException` to its own response (headers preserved) and unknown throws to a sanitized 500.
- **TS2589 guidance:** split routes into sub-apps (`const users = new Hono().get(...)`) and export per-slice `hc<typeof users>` clients. Avoid one monolithic `AppType`. Run `tsc --extendedDiagnostics` in CI and fail if instantiations exceed a budget.

### 5.3 tRPC v11 (`@fl/trpc`)

The dual-channel design:

- **Query and mutation errors use the error channel.** `Err(e)` becomes `throw new TRPCError({ code: map[e._tag], cause: e })`, and the suite's `errorFormatter` writes `data.fl = sanitize(e)`. The error then flows through tRPC's links into TanStack Query's error state, so retry, `throwOnError` and Error Boundaries behave correctly.
- **Forms can opt into the data channel.** `resultProcedure({ channel: "data" })` returns the Result as output, which is useful with `useActionState`-like flows.

```ts
export const errorFormatter: ErrorFormatter = ({ shape, error }) => ({
  ...shape,
  data: { ...shape.data,
    fl: isTagged(error.cause) ? sanitize(error.cause)
      : error.cause instanceof StandardSchemaV1Error ? ValidationFailure.fromIssues(error.cause.issues) : null },
});

export const domain = t.procedure.use(resultMiddleware({ NotFound: "NOT_FOUND", Conflict: "CONFLICT" }));
export const getUser = domain.input(IdSchema).query(({ input, ctx }) => users.find(ctx.deps, input.id)); // returns AsyncResult

// client
const r = await fromTRPC(trpc.user.get.query({ id }));   // Result<User, NotFound | Conflict | TRPCTransportError>
```

- **Format from Standard Schema issues.** Format from `StandardSchemaV1Error` or Standard Schema issues, not `instanceof ZodError`, so Valibot and ArkType inputs format correctly.\[39\]
- **The client-side error type is declared, not inferred per procedure.** tRPC infers the formatter shape globally, not per procedure.\[6\] So `fromTRPC` takes a type parameter or a procedure-level `errors` declaration, and that design limit should be documented. oRPC v2's per-procedure `.errors()` is genuinely better here.\[59\]\[65\]
- **TanStack Query:** with `@trpc/tanstack-react-query`'s `queryOptions`, pair the options with `retryUnless(isTag("NotFound", "Forbidden"))` from `@fl/query`.

### 5.4 TanStack Query (`@fl/query`)

```ts
export function toQueryFn<T, E, Args extends unknown[]>(fn: (...a: Args) => AsyncResult<T, E>):
  (...a: Args) => Promise<T extends undefined ? null : T>;   // throws E (plain object) on Err; Ok(undefined) → null

export const retryUnless = <E>(stop: (e: E) => boolean, max = 3) =>
  (failureCount: number, error: E): boolean => !stop(error) && failureCount < max;

export function resultQueryOptions<T, E, K extends QueryKey>(o: {
  queryKey: K; queryFn: (ctx: { signal: AbortSignal }) => AsyncResult<T, E>;
  retry?: (n: number, e: E) => boolean;
}): UseQueryOptions<T, E, T, K>;
```

- **Why throw the plain error object:** `query.error` becomes exactly `E`. Retry predicates and `throwOnError: (e) => e._tag === "Defect"` then work on tags. An `Err` returned inside `data` would never trigger retry or boundaries.\[40\]\[66\]
- **AbortSignal:** the query context's `signal` is forwarded into `fetchResult` and `tryAsync`.
- **Global error typing:** document augmenting `Register { defaultError: AppError }` (a v5 TypeScript feature; not re-verified this pass).

### 5.5 TanStack Router / Start / Form / Store (`@fl/tanstack-start`)

- **Start validator rename.** Use `.validator()`; `.inputValidator()` is gone in current Start. Pin `>=1.169`.\[2\]
- **Issue #6428 workaround.** `resultServerFn(schema, handler)` validates *inside* the handler using `@fl/schema`. A failure is returned as `Err(ValidationFailure)` data with structured issues, not thrown into the flattened `error.message`.\[7\] Domain errors are also returned as data. Only defects throw.

```ts
export const createPost = createServerFn({ method: "POST" })
  .validator((d: unknown) => d)                 // pass-through; real validation below keeps issue structure
  .handler(resultHandler(PostSchema, async ({ data, context }) => posts.create(context.deps, data)));
// client: const r = await createPost({ data }); if (!r.ok && r.error._tag === "ValidationFailure") ...
```

- **Error middleware.** Function middleware types require returning `next()`. Don't fight that with `as never`; do the conversion in the handler wrapper.\[7\]
- **Testing.** Validators are skipped on direct calls (issue #7507).\[41\] Because `resultHandler` validates inside the handler, unit tests exercise validation too, which is a side benefit.
- **Router.**
  - `validateSearch` accepts Standard Schema directly.
  - `loaderResult(r)` throws Router's `notFound()` for `NotFound` and `redirect({ to: "/login" })` for `Unauthenticated`. These are Router's sentinels and must not be wrapped in user try/catch.
  - Loaders that feed `@fl/query` use `ensureQueryData(resultQueryOptions(...))`.
- **Form.** Pass Standard Schemas straight to `validators`. `toFormErrors(validationFailure)` maps a server `Err` into `form.setErrorMap`. Use structural `_tag` checks, never `instanceof ServerValidateError`. Track the Form v2 alpha validator-array change before 1.0 of this adapter.\[42\]\[43\]\[44\]
- **Store.** Adapter hooks use `useSelector`. `useStore` is deprecated as of Store 0.11.\[67\]

### 5.6 Better Auth (`@fl/better-auth`)

**Traps the adapter absorbs:**

1. `auth.api.*` throws `APIError`, and `instanceof` fails across duplicate `better-call` copies. Use `isAPIError`.\[9\]
2. The client returns `{ data, error }` with `error.status`/`message` (and `code` since 1.5).\[8\]\[46\]
3. Cookies need `returnHeaders: true` when calling the server API outside a request handler.\[9\]
4. `databaseHooks` before-hooks signal by returning `false` (abort) or `{ data }` (replace), or by throwing `APIError`.\[68\]
5. Request hooks run through `createAuthMiddleware`, where `ctx.context.returned` may be an `APIError`.\[69\]

```ts
export type AuthError =
  | TaggedError<"Unauthenticated"> | TaggedError<"Forbidden">
  | (TaggedError<"AuthApiError"> & { status: number; code?: string });

export function authCall<T>(f: () => Promise<T>): AsyncResult<T, AuthError>;          // isAPIError → AuthApiError
export function fromAuthTuple<T>(r: { data: T | null; error: { status: number; message?: string; code?: string } | null }): Result<T, AuthError>;

export const requireSession = (auth: Auth, headers: Headers): AsyncResult<Session, TaggedError<"Unauthenticated">> => …;
export const requireRole = (role: string) => (s: Session): Result<Session, TaggedError<"Forbidden">> => …;

export function beforeDbHook<T>(f: (data: T) => AsyncResult<Partial<T> | void, TaggedError<"Rejected">>):
  (data: T) => Promise<false | { data: T } | void>;   // Err → false (or APIError when `throwOnReject`)
```

Per-framework wiring:

- **Next.js:** `await requireSession(auth, await headers())`, then `orRedirect("/login")`.
- **Hono:** a `requireSession` middleware sets `c.var.session` and responds 401 Problem on `Err`.
- **Start:** use it in request middleware.
- **Better Auth plugins:** document using `APIError.from(...)` codes, which map 1:1 to `AuthApiError.code`.\[46\]
- **Effect:** no official package exists (issue #7338), so `@fl/effect` + `authCall` *is* the bridge.\[49\]

### 5.7 Schema (`@fl/schema`)

```ts
export interface ValidationFailure extends TaggedError<"ValidationFailure"> {
  readonly issues: ReadonlyArray<{ readonly message: string; readonly path: ReadonlyArray<string | number> }>;
}
export function parse<S extends StandardSchemaV1>(s: S, u: unknown): Result<StandardSchemaV1.InferOutput<S>, ValidationFailure>; // throws Panic if validate is async
export function parseAsync<S extends StandardSchemaV1>(s: S, u: unknown): AsyncResult<StandardSchemaV1.InferOutput<S>, ValidationFailure>;
export function toFieldErrors(f: ValidationFailure): Record<string, string[]>;
export function toJsonSchema(s: StandardJSONSchemaV1, io: "input" | "output", target?: "draft-2020-12" | "draft-07"): Result<object, TaggedError<"Unsupported">>;
```

Paths are normalized from `PropertyKey | { key }` segments to `string | number`. Symbols are dropped and noted. `toJsonSchema` wraps the converter because the spec says it "may throw if conversion is not supported."\[17\]

### 5.8 Effect bridge (`@fl/effect`)

```ts
export function fromExit<A, E>(exit: Exit.Exit<A, E>): Result<A, E>;                 // Fail(E)→Err(E); Die/Interrupt→throw Panic(cause)
export function runResult<A, E>(eff: Effect.Effect<A, E, never>, opts?: { signal?: AbortSignal }): AsyncResult<A, E>;
export function toEffect<T, E>(r: Result<T, E> | AsyncResult<T, E>): Effect.Effect<T, E>;
```

Effect services stay behind server-side interpreters. Adapters only ever see Results. Import only `@stability`-stable modules, and run a CI job against `effect@latest` to catch minor-version breaks in unstable modules.\[30\]

### 5.9 HTTP, DB, env

- **`fetchResult(url, { schema, signal, timeoutMs, retry })`** returns `AsyncResult<T, HttpError | NetworkError | Timeout | ValidationFailure>`. `HttpError` carries `status` and parses `application/problem+json` bodies back into tagged errors, so Hono↔client round-trips are lossless.
- **DB error mappers:**
  - `mapPgError` maps SQLSTATE `23505` → `Conflict` and `23503` → `ForeignKeyViolation`. It works for Drizzle on `pg`/`postgres-js`/Neon because it reads `code` structurally.
  - `mapPrismaError` maps `P2002` → `Conflict` and `P2025` → `NotFound`. These codes come from Prisma's long-standing error reference and were not re-verified this pass.
  - Point to `@unthrown/drizzle` for a fuller Drizzle integration.\[53\]
- **`parseEnv`** is `parse` over `process.env` or `import.meta.env`. Document `@t3-oss/env` interop rather than competing with it.

---

## 6. Cross-cutting engineering

**Monorepo layout.**

- pnpm workspaces with Nx, matching your existing setup. Nx `release` or Changesets for versioning.
- Layout: `packages/*` (published), `tooling/*` (lint plugins, codemods) and `examples/*` (next-app, hono-worker, start-app, trpc-next) that run as integration tests.

**Builds.**

- tsdown (Rolldown-based) per package, ESM-only.
- Every target runtime (Node 20+, Bun, Deno, Workers, Vercel Edge, modern browsers) consumes ESM. Next.js and Vite handle ESM-only packages, and Node's `require(esm)` covers stragglers (verify the Node floor before publishing).

**Exports.**

```json
{
  "name": "@fl/next",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/server.d.ts",
      "react-server": "./dist/server.js",
      "default": "./dist/server-only-stub.js"
    },
    "./client": { "types": "./dist/client.d.ts", "default": "./dist/client.js" }
  },
  "peerDependencies": { "next": ">=16.3 <18", "react": ">=19.2" },
  "peerDependenciesMeta": { "react": { "optional": false } }
}
```

- Use `workerd`, `edge-light` and `browser` conditions only where code actually differs (`@fl/hono`, `@fl/otel`). `core` exposes `default` only.
- Ship `.d.ts` generated with `isolatedDeclarations` (fast, and tsdown can emit them without a full type check).

**Tree-shaking and size budgets.**

- size-limit in CI:
  - `import { ok, err, map, andThen, pipe }` ≤ 600 B min+gz.
  - Full `@fl/core` ≤ 3 kB.
  - Each adapter ≤ 2 kB excluding peers.
- Verify with an esbuild/Rolldown "import one symbol" fixture per export.

**Peer policy.**

- Peers only, never bundled framework code.
- Widest range that is tested. Each range lower bound equals the oldest version in the CI matrix.
- `@standard-schema/spec` is a types-only dependency (or vendored types, as tRPC does).

**Type testing.**

- Vitest `expectTypeOf` with `vitest --typecheck`, running against `typescript@6.0`, `@7.0` and `@7.1` (installed by npm alias).
- Avoid tsd and other tools bound to the old compiler API until they support 7.1's new API.\[21\]\[70\]
- Add a "perf" type test that fails if `tsc --extendedDiagnostics` instantiation counts for fixture files regress more than 20%.

**Law and property tests.**

- fast-check properties for the functor and monad laws (`map(id) = id`, `andThen(ok) = id`, associativity), dual-form equivalence, JSON round-trip (`JSON.parse(JSON.stringify(r))` deep-equals `r`), and `structuredClone` stability.
- Integration tests run each example app on Node, Bun, Deno and `wrangler dev`.

**Lint.**

- `must-use-result` is type-aware and flags discarded `Result`/`AsyncResult` expressions. TS itself doesn't enforce consumption; unthrown's own tracker concedes `Err("x")` compiles unused.\[55\]
- `no-try-around-redirect` flags redirect/notFound calls inside `try` without a preceding rethrow.\[62\]
- `no-instanceof-tagged-error` and `prefer-tag-match` round out the set.
- Ship ESLint (typescript-eslint) and an Oxlint JS plugin; unthrown ships an oxlint plugin as precedent.\[53\] Biome support is U.

**Docs for humans and agents.**

- Docs site plus `llms.txt` and `llms-full.txt`.
- An `AGENTS.md` and portable `SKILL.md` per package: "adopt-fl-core", "migrate-from-neverthrow", "next-server-actions". This follows better-result's shipped skills and Next.js 16.2's `AGENTS.md` in create-next-app.\[10\]\[50\]\[71\]
- Every error union is documented as a table of tags.

**Codemods.** Built with ast-grep or jscodeshift; note that ts-morph depends on the compiler API, so ts-morph-based codemods need TS ≤6 or 7.1.

- neverthrow → `@fl/core`:
  - `ok`/`err` keep their names.
  - `.map(f)` becomes `pipe(r, map(f))`.
  - `ResultAsync.fromPromise(p, f)` becomes `tryAsync(() => p, { catch: f })`.
  - `.match(a, b)` becomes `match(r, { ok: a, err: b })`.
- fp-ts `Either` → Result: `_tag: "Right"/"Left"` becomes `ok: true/false`.
- try/catch → `tryAsync`, inserting `nextRethrow` in Next.js files.

**Semver and stability.**

- 0.x until the MVP has run for a quarter in your own apps.
- At 1.0, core types are frozen. Breaking changes to the `Result` shape require a major version and a codemod.
- Per-export `@stability experimental` JSDoc tags, as Effect does. Experimental exports may break in minors.\[30\]
- Adapters version independently, with a compatibility table against framework versions.

**Publishing.** npm with provenance via GitHub OIDC, plus JSR for Deno (JSR's "slow types" rule aligns with `isolatedDeclarations`).

---

## 7. Naming and scope options

npm and JSR collisions could **not** be checked this pass. Run `npm view <name>` and check the JSR scope before committing.

| Candidate | Scope | Pros | Risk |
|---|---|---|---|
| **Plainfp** | `@plainfp/*` | Says "plain objects, plain functions" | Unchecked |
| **Railyard** | `@railyard/*` | Railway-oriented metaphor | Railway-themed names are common; unchecked |
| **Okerr** | `@okerr/*` | Short, describes the core | Unchecked; slightly cute |

Recommendation: **Plainfp** (`@plainfp/core`, `@plainfp/next`, …) if available. It encodes the core differentiator. `@fl/*` is a working name only; two-letter scopes are very likely taken.

---

## 8. Comparison with existing alternatives

| | This suite | neverthrow | byethrow | better-result 3 | unthrown | Effect 4 | fp-ts | next-safe-action | oRPC v2 |
|---|---|---|---|---|---|---|---|---|---|
| Result representation | Plain object `ok` | Class (U) | Plain object `type` | Class + codec | Class + brand, 3 variants | Exit/Result data types | `Either` `_tag` | n/a | n/a |
| Wire-safe without codec | ✅ | ❌ | ✅ | ❌ (codec) | ❌ | Schema-based | ✅ | ✅ (its own shape) | ✅ |
| Defect channel | Thrown + edge sanitize | ❌ | ❌ | `Panic` | ✅ 3rd variant | ✅ `Cause.die` | ❌ | Server error handler | Undefined errors |
| Tree-shakable functions | ✅ | ❌ methods | ✅ | Partial (namespace + dual) | Methods | ✅ | ✅ | — | — |
| Generator do-notation | Opt-in `$()` | ✅ (U) | `bind` | ✅ | ✅ | ✅ | ❌ | — | — |
| Next.js sentinel safety | ✅ built-in | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (U) | Partial (U) |
| TanStack Query Err→error bridge | ✅ | ❌ | ❌ | ❌ | ❌ | Atom libs (U) | ❌ | ❌ | ✅ own integration |
| TanStack Start #6428 workaround | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Hono status-literal responses + Problem Details | ✅ | ❌ | ❌ | ❌ | ❌ | HttpApi | ❌ | ❌ | OpenAPI handler |
| tRPC dual channel | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Native (`.errors`) |
| Better Auth normalization | ✅ | ❌ | ❌ | ❌ | ❌ | Community | ❌ | Adapter (U) | ❌ |
| Runtime / learning cost | Very low | Low | Low | Low | Low–med | High | High | Low | Medium |

The genuinely differentiated part is the right half of the table: framework-boundary correctness with one shared error vocabulary. The core is deliberately unremarkable.

---

## 9. Phased roadmap

| Phase | Duration | Deliverables | Exit criteria |
|---|---|---|---|
| **0. Spec** | 1 week | RFC for the Result shape, error taxonomy, wire envelope, Problem Details mapping; naming check | Signed off; npm scope secured |
| **1. MVP** | 3–4 weeks | `core` (incl. `/async`), `schema`, `next` (action, loaders, tryAsync, toResponse, client boundary), `must-use-result` + `no-try-around-redirect` lint rules, llms.txt + skills | One production Next.js 16.4 app in your Nx monorepo migrated for one feature; size budgets green; TS 6/7/7.1 matrix green |
| **2. Data layer** | 2–3 weeks | `query`, `better-auth`, `http`, `otel` | Typed `query.error` unions used in UI; auth guards replace ad-hoc session checks |
| **3. Servers** | 3 weeks | `hono` (respond, problem, sv, onError; Hono 5 RC tested), `trpc` (dual channel, formatter, client) | `hc` status unions inferred in tests; tRPC example with TanStack Query retry semantics verified |
| **4. TanStack Start** | 2 weeks | `tanstack-start` (resultServerFn, loaders, Form mappers) | Re-check #6428 status; drop the workaround if upstream fixes it |
| **5. Extras** | ongoing | `effect`, `db`, `env`, `/gen`, codemods (neverthrow, fp-ts, try/catch), oRPC recipe | 1.0 after a quarter of internal use |

Start comes last because its APIs are still churning.

---

## 10. Risks, open questions and caveats

- **Framework churn is the main risk.** Start renamed a core API without an alias; oRPC v2 removed typed returned errors mid-beta; Hono 5 and TS 7.1 are pre-stable; Next.js 17 will flip Cache Components on by default.\[1\]\[29\]\[35\]\[57\]\[72\] Mitigation: narrow peer ranges, a CI matrix that includes `@next`/`@rc` tags, and adapters kept to under a few hundred lines each.
- **`unstable_rethrow` is still unstable.** If Next.js renames it, only `@fl/next` changes. That is the reason for centralizing it.
- **No defect variant is a deliberate trade-off.** Teams that want defects as values should use unthrown or Effect.\[14\]\[73\] The suite's `InternalDefect` exists only at the wire.
- **Cross-procedure error typing in tRPC is weaker than oRPC's.** If you start a new API surface, oRPC v2 (once stable) or Hono RPC may serve better than tRPC.
- **Unverified items:**
  - From Document 1: Effect 4.1 (2 Nov 2026), fp-ts's "merged/at risk" status and download counts, the versions of ts-pattern, Remeda and es-toolkit, and tsrs.
  - From Document 2: neverthrow's current class implementation and gen support, next-safe-action's adapter, result-rpc, hono-problem-details, `unstable_rethrow`'s handling of `cause`, `HTTPException` header loss, and `experimental.authInterrupts` details.
  - Other: exact current patch versions of Next.js, TanStack Query, Form and Store, and the open/closed status of Better Auth issue #7338 and TanStack issue #6428.
  - Verify all of these before publishing peer ranges or docs that cite them.

## Sources

1. [Fix site-wide outage: createServerFn's .inputValidator() was renamed to .validator() by AADdev1 · Pull Request #14 · AADdev1/CRtattracker3.1\_secure · GitHub](https://github.com/AADdev1/CRtattracker3.1_secure/pull/14)
2. [Fix with-tanstack-ai-starter-full-backend for TanStack Start's validator() rename by andrelandgraf · Pull Request #297 · neondatabase/examples · GitHub](https://github.com/neondatabase/examples/pull/297)
3. [Changelog](https://better-auth.com/changelog)
4. [unstable\_rethrow](https://nextjs.org/docs/app/api-reference/functions/unstable_rethrow)
5. [Query Functions](https://tanstack.com/query/latest/docs/framework/react/guides/query-functions)
6. [Error Formatting](https://trpc.io/docs/server/error-formatting)
7. [inputValidator validation errors lose structure during serialization - issues array becomes JSON string in error.message](https://github.com/TanStack/router/issues/6428)
8. [Creem](https://better-auth.com/docs/plugins/creem)
9. [API | Better Auth](https://better-auth.com/docs/concepts/api)
10. [better-result/AGENTS.md at main · dmmulroy/better-result · GitHub](https://github.com/dmmulroy/better-result/blob/main/AGENTS.md)
11. [Dillon Mulroy on X: "better-result 3.0 is now available npm i better-result@3 highlights below" / X](https://x.com/dillon_mulroy/status/2083670990165291303?lang=en)
12. [Importing Result - byethrow](https://praha-inc.github.io/byethrow/guide/best-practices/importing-result)
13. [neverthrow - tutorial (with a bit of "byethrow")](https://dj-nuo.com/blog/2025/10/08/neverthrow-tutorial/)
14. [unthrown/CLAUDE.md at main · btravstack/unthrown · GitHub](https://github.com/btravstack/unthrown/blob/main/CLAUDE.md)
15. [standard-schema/packages/spec/README.md at main · standard-schema/standard-schema · GitHub](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/README.md)
16. [Standard Schema](https://standardschema.dev/)
17. [index - @standard-schema/spec - JSR](http://jsr.io/@standard-schema/spec/doc)
18. [standard-schema/packages/examples/json-implement.ts at main · standard-schema/standard-schema · GitHub](https://github.com/standard-schema/standard-schema/blob/main/packages/examples/json-implement.ts)
19. [TypeScript 7.1 Beta Released: New API Unblocks Vue, Svelte, and Angular Tooling](https://www.ntcompatible.com/story/typescript-71-beta-released-new-api-unblocks-vue-svelte-and-angular-tooling/)
20. [TypeScript 7.1 Beta Restores Compiler API](https://imasters.com/news/typescript-71-beta-restores-compiler-api-speeds-up-type-checking-vue-svelte)
21. [TypeScript 7.1 Beta: Restores the Compiler API and Makes Vue and Svelte](https://techbytes.app/posts/typescript-71-beta-restores-the-compiler-api-and-makes-vue/)
22. [Next.js 16: what's new?](https://makerkit.dev/blog/tutorials/nextjs-16)
23. [Next.js 16 (LTS) - What's New, Support Lifecycle & EOL — VersionLog](https://versionlog.com/nextjs/16/)
24. [Next.js 16.4 Released: What's New and How to Upgrade](https://easyspawn.com/blog/nextjs-16-4-released)
25. [catchError](https://nextjs.org/docs/app/api-reference/functions/catchError)
26. [Functions: catchError](https://nextjs.org/docs/pages/api-reference/functions/catchError)
27. [Error Handling in Next.js with catchError](https://aurorascharff.no/posts/error-handling-in-nextjs-with-catch-error/)
28. [Error Handling in Next.js with catchError - Certificates.dev](https://certificates.dev/blog/error-handling-in-nextjs-with-catcherror)
29. [Next.js 16.4: Cache Components and ensureStatic (2026)](https://robotostudio.com/blog/nextjs-16-4-for-dummies)
30. [Release @effect/platform-browser@4.0.0 · Effect-TS/effect · GitHub](https://github.com/Effect-TS/effect/releases/tag/%40effect/platform-browser%404.0.0)
31. [Effect 4.0 Ships: Dependency-Free Rewrite with 5x Smaller Bundles and Long-Term Support - InfoQ](https://www.infoq.com/news/2026/11/effect-4-0-release/)
32. [honojs/hono v4.10.0 on GitHub - Release Notes](https://newreleases.io/project/github/honojs/hono/release/v4.10.0)
33. [Releases · honojs/hono · GitHub](https://github.com/honojs/hono/releases)
34. [実用！Hono RPC2026 by yodaka - Speaker Deck](https://speakerdeck.com/yodaka/shi-yong-hono-rpc2026)
35. [Hono vs Express vs Fastify: 37% Throughput Gap \[2026\]](https://tech-insider.org/hono-vs-express-vs-fastify-2026/)
36. [I Tried Hono v5 RC: What Changed from v4, and What Breaks? - DEV Community](https://dev.to/tanahiro2010/i-tried-hono-v5-rc-what-changed-from-v4-and-what-breaks-2fl4)
37. [feat(server): add Standard Schema support by fabian-hiller · Pull Request #6079 · trpc/trpc · GitHub](https://github.com/trpc/trpc/pull/6079)
38. [tRPC v11 End-to-End Type Safety: Server + Client (2026)](https://nerdleveltech.com/trpc-v11-end-to-end-type-safety-server-client-tutorial)
39. [trpc - AI Agent Skill](https://skills.lc/pproenca/dot-skills/pproenca-dot-skills-skills-experimental-trpc-skill-md)
40. [useQuery](https://tanstack.com/query/latest/docs/framework/react/reference/functions/useQuery)
41. [Start: provide a supported way to unit-test server functions through the pipeline (inputValidator is skipped on direct calls) · Issue #7507 · TanStack/router · GitHub](https://github.com/TanStack/router/issues/7507)
42. [Basic Concepts and Terminology](https://tanstack.com/form/latest/docs/framework/react/guides/basic-concepts)
43. [Form v2 is here: All you need to know about the alpha](https://tanstack.com/blog/announcing-tanstack-form-v2-alpha)
44. [Tanstack Start Integration? · TanStack/form · Discussion #1928 · GitHub](https://github.com/TanStack/form/discussions/1928)
45. [Releases · TanStack/store · GitHub](https://github.com/TanStack/store/releases)
46. [Better Auth 1.5](https://better-auth.com/blog/1-5)
47. [GitHub - brandhaug/effectful-better-auth: Effect v4 integration for Better Auth. ESM-only, zero runtime dependencies; effect and better-auth are peers. · GitHub](https://github.com/brandhaug/effectful-better-auth)
48. [docs(integrations): add Effect integration guide by bytaesu · Pull Request #11566 · better-auth/better-auth · GitHub](https://github.com/better-auth/better-auth/pull/11566)
49. [Feature Request: Effect/Platform Native Integration](https://github.com/better-auth/better-auth/issues/7338)
50. [better-result-adopt](https://killer-skills.com/en/skills/dmmulroy/better-result)
51. [@praha/byethrow - npm](https://www.npmjs.com/package/@praha/byethrow)
52. [Why I Reinvented a Result Type Library - DEV Community](https://dev.to/karibash/why-i-reinvented-a-result-type-library-3ko4)
53. [GitHub - btravstack/unthrown: Explicit errors as values for TypeScript — with a separate defect channel for the unexpected and qualification enforced at every boundary. · GitHub](https://github.com/btravstack/unthrown)
54. [Release unthrown@5.11.0 · btravstack/unthrown · GitHub](https://github.com/btravstack/unthrown/releases/tag/unthrown%405.11.0)
55. [\[P2\] docs: qualify compiler guarantees and correct framework lifecycle comparisons · Issue #379 · btravstack/btravstack · GitHub](https://github.com/btravstack/btravstack/issues/379)
56. [Update oRPC, tRPC and Hono; rework the benchmark runner by dinwwwh · Pull Request #4 · middleapi/orpc-benchmarks · GitHub](https://github.com/middleapi/orpc-benchmarks/pull/4)
57. [feat!: remove typesafe returned errors and the inferable flag by dinwwwh · Pull Request #1987 · middleapi/orpc · GitHub](https://github.com/middleapi/orpc/pull/1987)
58. [Effect Integration - oRPC](https://orpc.dev/docs/integrations/effect)
59. [@unthrown/orpc - npm](https://www.npmjs.com/package/@unthrown/orpc?activeTab=dependents)
60. [unthrown — explicit errors as values for TypeScript](https://btravstack.github.io/unthrown/)
61. [TypeScript 7 Is Here: The Go Compiler Rewrite](https://morello.dev/blog/typescript-7-is-here)
62. [react-doctor/nextjs-no-redirect-in-try-catch - Docs](https://www.react.doctor/docs/rules/react-doctor/nextjs-no-redirect-in-try-catch)
63. [Hono vs Express: runtimes, types, and the tradeoff](https://www.turbostarter.dev/blog/hono-vs-express)
64. [Fix: Hono RPC Not Working — Client Type Inference, AppType Export, Validators, and Path Params - FixDevs](https://fixdevs.com/blog/hono-rpc-not-working/)
65. [oRPC - Typesafe APIs Made Simple 🪄](https://v2.orpc.dev/)
66. [react-query throwing errors question · TanStack/query · Discussion #3012 · GitHub](https://github.com/TanStack/query/discussions/3012)
67. [Reactivity](https://tanstack.com/form/latest/docs/framework/react/guides/reactivity)
68. [Database | Better Auth](https://better-auth.com/docs/concepts/database)
69. [Hooks](https://better-auth.com/docs/concepts/hooks)
70. [TypeScript 7 Native Go Port: What to Do](https://arg.software/blog/typescript-7-rewritten-in-go/)
71. [Next.js Blog](https://nextjs.org/blog)
72. [TypeScript 7.1 Beta Adds Go Compiler API, Content Mappers and es2026 Support](https://windowsforum.com/news/typescript-7-1-beta-adds-go-compiler-api-content-mappers-and-es2026-support.449274/)
73. [The Result pattern has a hole, and it's where your bugs hide - DEV Community](https://dev.to/btravers/the-result-pattern-has-a-hole-and-its-where-your-bugs-hide-59c3)
