# @friday-friday/fp-ts-sandbox1

Sandbox for functional-programming TypeScript experiments.

## Requirements

- Node 24 (LTS), see `.nvmrc`
- pnpm 12 (pinned via `packageManager`; enable with `corepack enable`)

## Scripts

- `pnpm check` — type-check with `tsc`
- `pnpm lint` — `oxlint` + `dprint check` (same toolchain as the Effect repo)
- `pnpm lint-fix` — `oxlint --fix` + `dprint fmt`
