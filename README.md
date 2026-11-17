# @friday-friday/fp-ts-sandbox1

Functional-light TypeScript suite: a plain-object `Result` core with thin, framework-boundary-correct adapters. **The adapters are the product** — one Result shape and one error vocabulary, correct at every framework boundary (Design Report, `docs/`).

## Requirements

- Node 24 (LTS), see `.nvmrc`
- pnpm 12 (pinned via `packageManager`; enable with `corepack enable`)

## Packages

| Package                                                                              | Status         | What it does                                                                                                                                              |
| ------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@friday-friday/core`](packages/core)                                               | ✅ implemented | Plain-object Result, tagged errors, dual combinators, pipe/flow, boundary triage; `/async` (retry/timeout/concurrency) and `/gen` (do-notation) subpaths  |
| [`@friday-friday/schema`](packages/schema)                                           | ✅ implemented | Standard Schema → Result: parse/parseAsync, field/form flatteners, phantom brands, JSON Schema                                                            |
| [`@friday-friday/next`](packages/next)                                               | ✅ implemented | Next.js adapter: sentinel-safe triage (unstable_rethrow), useActionState actions, loaders, problem+json toResponse, client boundary                       |
| [`@friday-friday/query`](packages/query)                                             | ✅ implemented | TanStack Query adapter: `toQueryFn` (Err throws the tagged error so `query.error === E`), `retryUnless`, `resultQueryOptions`                             |
| [`@friday-friday/better-auth`](packages/better-auth)                                 | ✅ implemented | Better Auth adapter: `authCall`/`fromAuthTuple`/`requireSession`/`requireRole`/`beforeDbHook`; one `AuthError` vocabulary, structural `isAPIError` triage |
| [`@friday-friday/http`](packages/http)                                               | ✅ implemented | HTTP client: `fetchResult` with Standard Schema decode, RFC 9457 problem+json parsing, lossless tagged-error reconstruction                               |
| `@friday-friday/hono` · `trpc` · `tanstack-start` · `otel` · `db` · `env` · `effect` | planned        | Phase 3+ — see `docs/plan/IMPLEMENTATION_PLAN.md`                                                                                                         |
| [`tooling/eslint-plugin`](tooling/eslint-plugin)                                     | ✅ implemented | must-use-result, no-try-around-redirect, no-instanceof-tagged-error (enforced repo-wide)                                                                  |

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
- `pnpm smoke`: run built `dist` output under plain Node (core + schema; the next adapter requires the Next.js runtime)
- `pnpm ci`: run everything CI runs (lint, typecheck, test, size) locally before pushing

## Status

Phase 1 (MVP) in progress: core + schema + next + lint rules ✅ merged; `examples/next-app` (#9) is the remaining exit criterion. Living status: `docs/plan/IMPLEMENTATION_PLAN.md`. 0.x — nothing is published to npm.
