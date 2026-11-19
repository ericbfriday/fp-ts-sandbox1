# AGENTS.md — fp-ts-sandbox1

Project brief: see **`IDEA.md`** (read it first). The authoritative design source is `docs/Functional-Light TypeScript Library Suite ... Design Report (November 2026).md`; `IDEA.md` §3 ranks the research docs and lists known conflicts (Design Report wins). The **living plan** — phase status, verified evidence baseline, deferred-work register — is `docs/plan/IMPLEMENTATION_PLAN.md`. Commands live in `README.md`.

## Commands

- `pnpm run check` — typecheck (`tsc --noEmit`, root project + each example's own tsconfig) + the type-instantiation budget (`tooling/type-budget`), TS 7 locally; CI also runs TS 6.0 / 7.1-beta via npm aliases
- `pnpm run lint` — oxlint (type-aware) + local ESLint rules (`packages/*/src` + `examples/*/src`, enforced) + dprint check
- `pnpm run lint-fix` — oxlint --fix + dprint fmt
- `pnpm test` — Vitest runtime + type tests; `pnpm test:types` for type-only
- `pnpm run build` / `pnpm run size` / `pnpm run smoke` — build, size budgets, dist smokes
- `pnpm run smoke:source` — every package entry loads from `src` under plain Node 24 with `--conditions=@friday-friday/source` and matches dist's exports (ADR-0002; next excluded, no `exports` map; needs `pnpm run build`)
- `pnpm run pack:check` — publish gate (#65): `pnpm pack` every `packages/*` package, then publint `--strict` + attw `--profile esm-only` on the tarball; the packed manifest must have no `@friday-friday/source` condition (each package's `publishConfig.exports` drops it) and a `repository.directory` (needs `pnpm run build`; never publishes)
- `pnpm run build:examples` — `next build` of each example (needs `pnpm run build` first: the app resolves package `dist`)
- `pnpm run ci` — everything CI runs, locally

## Conventions

- ESM-only, TypeScript 7, **erasable syntax only** (no `enum`, `namespace`, parameter properties); `isolatedDeclarations`-clean — explicit return types on every export.
- Relative imports name the file on disk: `./internal.ts`, not `./internal.js` (src and tests). Node type stripping reads no tsconfig; `rewriteRelativeImportExtensions` + tsdown keep `.js` in dist. ADR-0002, #63.
- **Module resolution is `bundler`** (not NodeNext): next@16.4.6 ships an empty exports map, so NodeNext cannot resolve `next/*` subpaths. See ADR-0004.
- Small PR-sized steps: one package or concern at a time, each landing with its own tests, feature branch → PR → CI → review → merge to main.
- Source of truth for locked design decisions is `IDEA.md` §4. To change one, stop and write a note in `docs/decisions/` first.
- Cite the research doc section in commit messages / ADRs when implementing a trap-absorbing behavior.
- Mark unverified claims with `U` in docs and comments; verify before removing the mark.
- Never publish to npm from this repo without Eric's explicit say-so. Public repo: never commit secrets.
- Scope names in code: `@friday-friday/*` (not the report's `@fl/*` placeholders).
- Lint directives: this repo runs BOTH oxlint and ESLint. Use `// oxlint-disable-next-line <rule>` for oxlint rules and `// eslint-disable-next-line <rule>` for ESLint rules — each tool errors on the other's unknown rule ids.

## Package map (implemented)

Every `packages/*` entry has a size budget (`.size-limit.json`) and a plain-Node dist smoke (`test/smoke.mjs`; next's stubs `next/*`, which has no `exports` map); `tooling/gates` fails CI when a package or subpath misses either, or is missing here.

- `packages/core` — `@friday-friday/core` (+ `/async`, `/gen`, `/wire` subpaths): Result, tagged errors, combinators, defect triage, wire envelope
- `packages/schema` — `@friday-friday/schema`: Standard Schema to Result, `ValidationFailure`, field/form errors
- `packages/next` — `@friday-friday/next` (+ `/client` subpath; `react-server`/`default` conditions): Server Actions, loaders, route handlers; `/client` boundary helpers for client-thrown errors only (`resultBoundary`, `orThrow`). Its smoke stubs `next/*` (next@16.4 has no `exports` map) and checks the `client-only` guard under `react-server`
- `packages/hono` — `@friday-friday/hono`: `respond`/`problem`, `sv` validator, `onErrorHandler`
- `packages/trpc` — `@friday-friday/trpc`: `errorFormatter`, `resultMiddleware`, `resultResolver` (procedures with `.output()`), `fromTRPC`
- `packages/tanstack-start` — `@friday-friday/tanstack-start`: `resultHandler`, `loaderResult`, form errors
- `packages/query` — `@friday-friday/query`: `resultQueryOptions`, `toQueryFn`, `retryUnless` (TanStack Query)
- `packages/better-auth` — `@friday-friday/better-auth`: `requireSession`/`requireRole`, `authCall`, `fromAuthTuple`, `beforeDbHook`
- `packages/http` — `@friday-friday/http`: `fetchResult`, `reconstruct`
- `packages/otel` — `@friday-friday/otel`: `traced`/`tracedSync` spans tagged with the error tag
- `packages/db` — `@friday-friday/db`: Postgres/Prisma driver errors to tagged errors
- `packages/env` — `@friday-friday/env`: `parseEnv` (redacted issues), `envRecord`
- `packages/effect` — `@friday-friday/effect`: Result/Effect bridge (`toEffect`, `fromExit`, `runResult`)
- `tooling/eslint-plugin` — `@friday-friday/eslint-plugin`: the three custom rules, run on `packages/*/src` and `examples/*/src` (from `src`). Publish-ready (#106, #44 decision 8): tsdown build to `dist`, dist smoke, and covered by `pnpm run pack:check` via `shippedTooling`; peers `eslint`, `typescript-eslint`. Not published until Eric says so.
- `tooling/codemods` — `neverthrow-imports.mjs`, a neverthrow → core import rewriter that flags method calls for REVIEW (plain script, not a workspace package; internal, never shipped: #44 decisions 3 and 8)
- `tooling/gates` — gate-coverage tests + `src/source-smoke.ts` (`pnpm run smoke:source`, ADR-0002) + `src/publish-gate.ts` (`pnpm run pack:check`, #65) (plain dir, not a workspace package)
- `tooling/type-budget` — type-instantiation budget: core stress fixture, per-TS ceilings, `src/check.ts` (plain dir, not a workspace package)
- `examples/next-app` — `@friday-friday/example-next-app`: profile form end-to-end on Result (issue #9); typechecked with its own tsconfig and built with `next build` in CI

## Agent skills

### Issue tracker

GitHub Issues on `ericbfriday/fp-ts-sandbox1` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
