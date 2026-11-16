# @friday-friday/fp-ts-sandbox1

Sandbox for functional-programming TypeScript experiments.

## Requirements

- Node 24 (LTS), see `.nvmrc`
- pnpm 12 (pinned via `packageManager`; enable with `corepack enable`)

## Layout

pnpm workspace (ADR-0001): `packages/*` (publishable), `tooling/*` (internal), `examples/*` (integration).

## Scripts

- `pnpm check`: type-check the whole workspace with `tsc` (TS 7; CI also runs TS 6.0 and 7.1-beta)
- `pnpm lint`: type-aware `oxlint`, then the local ESLint rules (`tooling/eslint-plugin`), then `dprint check` (ADR-0003)
- `pnpm lint-fix`: `oxlint --fix` + `dprint fmt`
- `pnpm test`: Vitest runtime tests plus `*.test-d.ts` type tests (`--typecheck`); `pnpm test:types` runs only the type tests
- `pnpm build`: tsdown build of every `packages/*` (ESM + `.d.ts`, ADR-0002)
- `pnpm size`: build, then size-limit budgets (ADR-0004)
- `pnpm smoke`: run built `dist` output under plain Node
