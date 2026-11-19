# @friday-friday/fp-ts-sandbox1

Functional-light TypeScript suite: a plain-object `Result` core with thin, framework-boundary-correct adapters. **The adapters are the product** — one Result shape and one error vocabulary, correct at every framework boundary (Design Report, `docs/`).

## Requirements

- Node 24 (LTS), see `.nvmrc`
- pnpm 12 (pinned via `packageManager`; enable with `corepack enable`)

## Packages

| Package                                                                         | Status         | What it does                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@friday-friday/core`](packages/core)                                          | ✅ implemented | Plain-object Result, tagged errors, the fixed-vocabulary factories (ADR-0005, enforced by `taggedError`'s types), dual combinators, pipe/flow, boundary triage; subpaths `/async`, `/gen` (do-notation), `/wire` (RFC 9457 envelope) |
| [`@friday-friday/schema`](packages/schema)                                      | ✅ implemented | Standard Schema → Result: parse/parseAsync, field/form flatteners, phantom brands, JSON Schema                                                                                                                                       |
| [`@friday-friday/next`](packages/next)                                          | ✅ implemented | Next.js adapter: sentinel-safe triage (unstable_rethrow), useActionState actions, loaders, problem+json toResponse, client-thrown boundary                                                                                           |
| [`@friday-friday/query`](packages/query)                                        | ✅ implemented | TanStack Query adapter: `toQueryFn` (Err throws the tagged error so `query.error === E`), `retryUnless`, `resultQueryOptions`                                                                                                        |
| [`@friday-friday/better-auth`](packages/better-auth)                            | ✅ implemented | Better Auth adapter: `authCall`/`fromAuthTuple`/`requireSession`/`requireRole`/`beforeDbHook`; one `AuthError` vocabulary on core's fixed tags, structural `isAPIError` triage                                                       |
| [`@friday-friday/http`](packages/http)                                          | ✅ implemented | HTTP client: `fetchResult` with Standard Schema decode, RFC 9457 problem+json parsing, tagged-error reconstruction; transport errors are core's `NetworkError` / `Timeout`                                                           |
| [`@friday-friday/otel`](packages/otel)                                          | ✅ implemented | OpenTelemetry spans: `traced`/`tracedSync` mark Err as ERROR with `friday_friday.error.tag` (no exception records); defects recorded as exceptions                                                                                   |
| [`@friday-friday/hono`](packages/hono)                                          | ✅ implemented | Hono adapter: `respond` with status-literal unions (`hc` inference proven), RFC 9457 `problem()`, `sv` Standard-Schema validation, `onErrorHandler`                                                                                  |
| [`@friday-friday/trpc`](packages/trpc)                                          | ✅ implemented | tRPC v11 dual channel: `resultMiddleware` error-channel throws with mapped codes, `errorFormatter({ report })` → `data.friday_friday` (core `/wire`), data channel: plain procedures, `fromTRPC`                                     |
| [`@friday-friday/tanstack-start`](packages/tanstack-start)                      | ✅ implemented | TanStack Start/Router: `resultHandler` (in-handler validation, #6428 workaround), `loaderResult` (notFound/redirect sentinel mapping), `toFormErrors`                                                                                |
| [`@friday-friday/db`](packages/db)                                              | ✅ implemented | DB error mappers: SQLSTATE / P-codes → core's fixed tags (`Conflict`, `NotFound`, `DbUnavailable`) + FK/not-null tags, zero vendor imports                                                                                           |
| [`@friday-friday/env`](packages/env)                                            | ✅ implemented | `parseEnv`: Standard Schema over `process.env`/`import.meta.env`; ValidationFailure field errors, no throw at import time                                                                                                            |
| [`@friday-friday/effect`](packages/effect)                                      | ✅ implemented | Effect bridge: `fromExit` (Fail -> Err, Die/Interrupt -> Panic), `runResult` (failures as data), `toEffect`; stable modules only                                                                                                     |
| [`tooling/codemods`](tooling/codemods) + [`docs/recipes`](docs/recipes/orpc.md) | ✅ implemented | neverthrow→core codemod (fixture-tested) + oRPC v2 pairing recipe (`llms.txt` shipped at the repo root)                                                                                                                              |
| [`tooling/eslint-plugin`](tooling/eslint-plugin)                                | ✅ implemented | must-use-result, no-try-around-redirect, no-instanceof-tagged-error (enforced repo-wide)                                                                                                                                             |

## Documentation map

- `IDEA.md` — project brief and locked design decisions (§4)
- `docs/plan/IMPLEMENTATION_PLAN.md` — **living plan**: verified evidence baseline, phase status, deferred/accepted-limitations register
- `docs/spec/rfc-0001-core.md` — core spec (Result shape, error taxonomy, wire envelope, problem+json)
- `docs/adr/` — architecture decisions (workspaces, tsdown, linter strategy, test/CI stack)
- `docs/decisions/` — dated amendment notes (e.g. /async signal handling)
- `docs/agents/` — issue-tracker, triage-label and domain-doc conventions
- `docs/` research reports — authoritative source material (Design Report wins conflicts)

## Scripts

- `pnpm check`: type-check the whole workspace with `tsc` (TS 7; CI also runs TS 6.0 and 7.1-beta)
- `pnpm lint`: type-aware `oxlint`, then the local ESLint rules (`tooling/eslint-plugin`, enforced repo-wide), then `dprint check` (ADR-0003)
- `pnpm lint-fix`: `oxlint --fix` + `dprint fmt`
- `pnpm test`: Vitest runtime tests plus `*.test-d.ts` type tests (`--typecheck`); `pnpm test:types` runs only the type tests
- `pnpm build`: tsdown build of every `packages/*` (ESM + `.d.ts`, ADR-0002)
- `pnpm size`: build, then size-limit budgets (ADR-0004)
- `pnpm run smoke`: run built `dist` output under plain Node (every package; next's smoke stubs `next/*`, which ships no `exports` map, and checks `/client` refuses to load under `react-server`)
- `pnpm run ci`: run every gate CI runs, locally, before pushing: lint, typecheck (TS 7 only; CI adds the 6.0 and 7.1-beta matrix), test, size, smoke. Spell it `pnpm run ci`: in pnpm 12 a bare `pnpm ci` is the built-in clean install and never runs this script

## Status

Phases 1–4 complete + Phase 5 nearly: core, schema, next, examples/next-app (#9), query, better-auth, http, otel, hono, trpc, tanstack-start, db, env, effect, llms.txt all landed. Phase 5 code scope complete; remaining: per-package AGENTS docs polish. Living status: `docs/plan/IMPLEMENTATION_PLAN.md`. 0.x — nothing is published to npm.
