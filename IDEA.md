# IDEA.md — Functional-Light TypeScript Suite (fp-ts-sandbox1)

> Project brief for the Hermes client. Read this first, then read `AGENTS.md` for repo conventions once it exists.

> **LIVING STATUS (18 Nov 2026):** Phases 0–5 code scope is complete and merged to main: `core` (+ `/async`, `/gen`, `/wire`), `schema`, `next`, `examples/next-app` (#9), `query`, `better-auth`, `http`, `otel`, `hono`, `trpc`, `tanstack-start`, `db`, `env`, `effect`, the ESLint rules, the neverthrow codemod, the oRPC recipe and `llms.txt`. Current work is architecture-review follow-ups (#30, #51): interfaces that keep their promises and gates that can fail. Two §5 items were not built and are explicitly deferred (`toMutationFn`, core `/interop`; reasons in the plan's register). The authoritative working plan — verified version/issue evidence table, deferred-and-accepted-limitations register, phase status — is **`docs/plan/IMPLEMENTATION_PLAN.md`**; it supersedes the open questions in §10 below (all resolved in `docs/adr/` and the plan). Repo conventions: `AGENTS.md`; domain terms: `GLOSSARY.md`.

> Status date: **18 Nov 2026**. Version facts below are moving targets; re-verify before pinning peer ranges.

## 1. The idea in one paragraph

Build a **small, zero-dependency functional core** (a plain-object `Result`, JSON-safe tagged errors, pipeable dual functions) plus **thin adapters** for the stack Eric actually ships on: **Next.js, Hono, tRPC, TanStack (Query / Router / Start / Form / Store) and Better Auth**. Result libraries already exist (byethrow, better-result, unthrown, Effect 4). What none of them does is absorb the *framework-boundary traps* that make errors-as-values awkward in a real stack. The adapters are the product. The core is deliberately unremarkable.

Differentiator: **one Result shape and one error vocabulary, with correct behavior at every framework boundary.**

## 2. Who and where

- Owner: Eric (GitHub `ericbfriday`), full-stack TypeScript engineer, Twin Cities.
- Repo: **`fp-ts-sandbox1`**, new **public** GitHub repo, MIT license.
- npm scope: **`@friday-friday`** (e.g. `@friday-friday/core`, `@friday-friday/next`). The design report uses `@fl/*` as a working name and floats "Plainfp"; treat both as placeholders and use `@friday-friday/*` in code.
- Toolchain choices already made: **pnpm**, **Node 24 LTS** target, the **same linter Effect uses**.
  - Evidence points to **Oxlint (type-aware, via oxlint-tsgolint)**: the Effect tooling in this ecosystem emits Oxlint type-aware rules. Confirm against Effect's own repo config when scaffolding, then record the answer in `AGENTS.md`.
- Eric works in an Nx/Next.js monorepo at NMDP, so the design should drop into pnpm + Nx workspaces cleanly. This sandbox is where the ideas get proven first.

## 3. Source material and which to trust

The research lives in the Claude Project **"FP TS"** (copy into `docs/research/` if Hermes cannot reach it):

| Doc | Role |
|---|---|
| `Functional-Light TypeScript Library Suite for Next.js, Hono, TanStack, tRPC and Better Auth_ Design Report (November 2026).md` | **Authoritative.** Verified design, package map, roadmap. Wins every conflict. |
| `TypeScript FP Architecture and Adapters.md` | Earlier blueprint. Useful adapter ideas; several claims are unverified or wrong (below). |
| `Functional TypeScript Trends and Challenges.md` | Ecosystem/compiler background (Effect 4, TS 7, HKT limits). Context only. |

Known conflicts, resolved in favor of the Design Report:

- Result discriminant is **`ok: boolean`**, not `status: "ok" | "err"`.
- better-result's `Ok`/`Err` are **classes** (v3 uses `Result.codec` for the wire); byethrow is the plain-object reference.
- TanStack Start's current API is **`.validator()`**; `.inputValidator()` was removed with no alias (pin `>=1.169`).
- Claims the report marks **U (unverified)** stay unverified until checked: neverthrow internals, next-safe-action adapters, result-rpc, hono-problem-details, `unstable_rethrow` and `error.cause`, `HTTPException` header loss, `experimental.authInterrupts` details.

## 4. Locked design decisions

1. **Result shape:** `{ ok: true, value } | { ok: false, error }`. Interfaces with `out` variance annotations. No classes, no prototypes, so Results survive `structuredClone`, RSC payloads, `"use cache"`, tRPC transformers and `JSON.stringify` unchanged.
2. **Errors are plain data:** `{ _tag: "NotFound", ... }` built by a `taggedError(tag)` factory with a structural `is()` guard. Never `instanceof` (duplicate module copies break it; Better Auth and TanStack Form both document this). `cause` stays server-side and is stripped before any boundary.
3. **Defects are thrown, not values.** No third union member. Callbacks that throw inside `map`/`andThen` become `Panic`. Every adapter's outermost layer sanitizes unknown throws into an `InternalDefect` response and reports the original.
4. **Triage at boundaries:** `tryAsync(fn, { catch, rethrow, signal })`. `catch` returning `undefined` means "defect, rethrow". No global rethrow registry; adapters export pre-bound variants.
5. **Combinators:** pure, pipeable, **dual** (data-first and data-last via `arguments.length`), separate named exports with `/*#__PURE__*/` so unused ones tree-shake. `pipe`/`flow` use explicit overloads (16 / 12 arity), not recursive types.
6. **No HKT encoding.** Everything is monomorphic over `Result`. Fewer TS2589 failures, better hover text. TypeScript 7 preserves 6.0 type-checking semantics, so these limits still apply.
7. **No Option type.** Use `T | undefined` plus `fromNullable(x, () => NotFound(...))`.
8. **Async lives in `/async`** (`Promise<Result>`; `retry`, `timeout`, `mapConcurrent`, all taking `{ signal }`). **Do-notation lives in `/gen`**, opt-in, via a `$()` wrapper so Results stay pure data.
9. **Validation is Standard Schema only** (`@standard-schema/spec` 1.1, types only). Never a hard dependency on Zod, Valibot or ArkType.
10. **Effect is an optional bridge** (`effect ^4.0`), importing only `@stability`-stable modules. DI is plain: functions take a `deps` object first.
11. **ESM-only, erasable syntax only** (no `enum`, `namespace`, parameter properties), `isolatedDeclarations` clean so source runs under Node type stripping.

## 5. Package map

All adapters import `core` (and `schema`) plus their own peers. They never import each other, and they export framework glue only: callers import `ok`/`err`/`taggedError` from `core` and vendor namespaces (Effect's `Effect`/`Exit`/`Cause`) from the vendor (#44 decision 6, #64). Rows marked *deferred* were not built; the reason is in the plan's deferred-work register.

| Package | What it does | Peers |
|---|---|---|
| `core` | Result, tagged errors, pipe/flow, combinators; subpaths `/async`, `/gen`, `/wire` (`/interop`: *deferred*) | none |
| `schema` | `parse`/`parseAsync` → `Result<T, ValidationFailure>`, `toFieldErrors`, `toFormErrors`, `branded`, `toJsonSchema` | none |
| `next` | `action` (for `useActionState`), `tryAsync` with `unstable_rethrow`, `orNotFound`/`orRedirect`, `toResponse`, `catchError` fallbacks | `next >=16.3 <18`, `react >=19.2` |
| `query` | `toQueryFn`, `resultQueryOptions`, `retryUnless` (`toMutationFn`: *deferred*) | `@tanstack/query-core ^5` |
| `better-auth` | `authCall`, `fromAuthTuple`, `requireSession`, `requireRole`, `beforeDbHook` | `better-auth ^1.6 \|\| ^1.7` |
| `hono` | `respond` (status-literal unions), `problem` (RFC 9457), `sv`, `onErrorHandler` | `hono ^4.10 \|\| ^5.0.0-0` |
| `trpc` | `resultMiddleware`, `errorFormatter`, `fromTRPC` (data channel: a plain procedure without the middleware) | `@trpc/server ^11`, `@trpc/client ^11` |
| `tanstack-start` | `resultHandler`, `loaderResult`, `toFormErrors` (from `schema`) | `@tanstack/router-core ^1.169` |
| `http`, `db`, `env`, `effect`, `otel` | `fetchResult`, DB error mappers, `parseEnv`, Effect bridge, tracing | optional |
| `eslint-plugin` (no Oxlint-native plugin: type-aware JS plugins unsupported, ADR-0003) | `must-use-result`, `no-try-around-redirect`, `no-instanceof-tagged-error` | lint host |

## 6. Framework traps the adapters must absorb

| Framework | Trap | Adapter behavior |
|---|---|---|
| Next.js | `redirect()` / `notFound()` / `forbidden()` / `unauthorized()` throw sentinels; any `try/catch` swallows them. `unstable_rethrow` is still marked unstable. | Call it first in every catch (walk `cause` to depth 5 defensively). Isolate it in `@…/next` so a rename touches one package. |
| Next.js | Throwing from a Server Action destroys form state and redacts messages to a digest. | Return Results to `useActionState`; throw only defects. |
| TanStack Query | `queryFn` must throw or reject; `undefined` data counts as failure. | `toQueryFn` throws the plain `E` on `Err`, maps `Ok(undefined)` to `null`, forwards `AbortSignal`. |
| TanStack Start | Issue #6428: validation issues are JSON-stringified into `error.message`. Validator skipped on direct calls (#7507). | Validate **inside** the handler and return `Err(ValidationFailure)` as data. |
| Better Auth | Server throws `APIError`, client returns `{ data, error }`; `instanceof` fails across copies. | Normalize both to `Result<T, AuthError>` using `isAPIError`. |
| Hono | `hc` infers only from chained routes and literal status codes; big `AppType` hits TS2589. | `respond(c, result, { NotFound: 404, … } as const)`; split routes into per-slice sub-apps and clients. |
| tRPC | One global `errorFormatter`; client error type is not per-procedure. | Errors go through the error channel (so retry and boundaries work); format from Standard Schema issues, not `ZodError`. |

## 7. Scope: what to build first

Order from the roadmap. Do not start a later phase until the earlier one's exit criteria hold.

0. **Spec (RFC in `docs/`):** Result shape, error taxonomy, wire envelope, Problem Details mapping.
1. **MVP: `core` + `schema` + `next`** with the two lint rules and `llms.txt`. Exit: size budgets green, TS 6.0/7.0/7.1 matrix green, one `examples/next-app` feature running on Result.
2. **Data layer:** `query`, `better-auth`, `http`, `otel`.
3. **Servers:** `hono`, `trpc`.
4. **TanStack Start:** last, because its APIs are still churning. Re-check #6428 first; drop the workaround if fixed upstream.
5. **Extras:** `effect`, `db`, `env`, codemods (neverthrow, fp-ts, try/catch), an oRPC recipe (docs only).

Stay at **0.x** until the MVP has run for a quarter in Eric's own apps.

## 8. Quality bars

- **Size (size-limit, min+gz):** `{ ok, err, map, andThen, pipe }` ≤ 600 B; full `core` ≤ 3 kB; each adapter ≤ 2 kB excluding peers.
- **Types:** Vitest `expectTypeOf` with `--typecheck` against TypeScript 6.0, 7.0 and 7.1 (npm aliases). Avoid tools bound to the old compiler API (tsd, ts-morph codemods) until 7.1's `typescript/sync` / `typescript/async` are stable. Add a type-instantiation budget check using `tsc --extendedDiagnostics`.
- **Laws and wire:** fast-check properties for functor/monad laws, dual-form equivalence, `JSON.parse(JSON.stringify(r))` equality and `structuredClone` stability.
- **Runtime matrix for examples:** Node, Bun, Deno, `wrangler dev`.
- **Lint:** type-aware `must-use-result` (TypeScript does not force callers to consume a Result), `no-try-around-redirect`, `no-instanceof-tagged-error`. Write these locally; do not add third-party neverthrow lint plugins (supply-chain incidents were reported).
- **Exports:** conditional exports with `react-server` / `default` for Next-facing code; `sideEffects: false`; `workerd` / `edge-light` conditions only where code truly differs.
- **Publishing (later):** npm with provenance via GitHub OIDC, JSR for Deno.

## 9. Non-goals

- No effect runtime, fibers or Layers in the core. Effect stays a bridge.
- No HKT/typeclass machinery. No Option type.
- No re-implementing collections (`groupBy`, `chunk`) or pattern matching beyond a small `matchTag`; defer to Remeda / es-toolkit / ts-pattern.
- No official oRPC package; a short interop recipe is enough.
- No claims of benchmarks we have not run.

## 10. Open questions to resolve before coding

1. Final scope and package names (`@friday-friday/*` is fine for the sandbox; run `npm view` on any public name later).
2. Which linter exactly, and its config style (`.oxlintrc.json` vs `oxlint.config.ts`). Custom type-aware JS plugins are **not yet supported** in Oxlint, so `must-use-result` may need an ESLint (typescript-eslint) flat-config fallback. Decide and document.
3. Nx vs plain pnpm workspaces for the sandbox. Report assumes pnpm workspaces, with Nx or Changesets for releases.
4. Build tool: report suggests **tsdown**, ESM-only.
5. Re-verify before citing in docs: current patch versions (Next.js 16.4.x, Better Auth 1.7.x, TanStack Query/Form/Store), TS 7.1 stable date (planned 24 Nov 2026), Hono 5 RC behavior, status of Better Auth #7338 and TanStack #6428.

## 11. How Hermes should work in this repo

- **Plan, then scaffold.** First task: propose the directory layout and root config for review, then create it. Do not publish anything to npm.
- **Small PR-sized steps**, one package or concern at a time. Each step lands with its own tests.
- **Source of truth for decisions is section 4.** If a task seems to need a change to a locked decision, stop and write a short note in `docs/decisions/` rather than editing silently.
- **Cite the research doc section** in commit messages or ADRs when implementing a trap-absorbing behavior.
- **Mark unverified facts** with `U` in docs and code comments, the way the Design Report does. Verify against official docs or release notes before removing the mark.
- **Pin conservatively:** each peer range's lower bound equals the oldest version in the CI matrix.
- **Never put secrets or credentials in the repo.** Public repo.

### Suggested first tasks

1. Scaffold the pnpm workspace (`packages/*`, `tooling/*`, `examples/*`), Node 24 `engines`, `.nvmrc`, MIT `LICENSE`, `.gitignore`, strict `tsconfig.base.json` (`isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax`).
2. Add the linter, formatter and CI skeleton (typecheck, lint, test, size-limit), and record the linter decision.
3. Implement `core`: `ok`/`err`/`isResult`, `taggedError`, `map`/`mapErr`/`andThen`/`match`/`matchTag`/`fromNullable`, `pipe`/`flow`, with law and JSON round-trip tests.
4. Implement `schema` over Standard Schema with `parse`, `parseAsync`, `toFieldErrors`.
5. Implement `next`: `tryAsync` with `unstable_rethrow`, `action` for `useActionState`, and the `no-try-around-redirect` rule, with an `examples/next-app` proving redirects survive.
6. Write `AGENTS.md` (commands, conventions) and `llms.txt` once the first packages exist.

## 12. A note on how Hermes loads this file

Hermes auto-loads `AGENTS.md`, `.hermes.md` and `CLAUDE.md`; it does not auto-load `IDEA.md`. Either add one line to `AGENTS.md` such as "Project brief: see `IDEA.md`", or pass this file explicitly at session start.
