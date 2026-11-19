# ADR 0002 — Build tool: tsdown, ESM-only

Status: Accepted (verification gate in scaffold task) · Date: 2026-11-16

## Context

Design Report §6: builds should use tsdown (Rolledown-based), ESM-only, with `.d.ts` emitted under `isolatedDeclarations`. TypeScript 7 (Go) has no programmatic compiler API until 7.1, so build tooling must not depend on the old `ts` API surface.

## Decision

**tsdown** per package, ESM-only output, `dts: true` via isolatedDeclarations. `sideEffects: false` everywhere. Conditional `exports` per package (e.g. `react-server`/`default` for `@friday-friday/next`); `workerd`/`edge-light` only where code truly differs.

## Verification gate

The scaffold task must prove on this machine: `tsdown build` for a trivial package emits `dist/*.js` + `dist/*.d.ts`, and the output runs under Node 24 type-stripping. If tsdown × TS 7 fails, fall back to `tsc --build` + `rolldown` and record it here.

**Outcome (2026-11-16, Windows 11 x64, Node 24.19.0, TypeScript 7.0.2): PASSED. No fallback needed.**

- `tsdown 0.23.7` (rolldown 1.3.2) built `packages/core` to `dist/index.js` (0.28 kB) and `dist/index.d.ts` (0.86 kB). Declarations come from isolatedDeclarations (oxc), with no TS compiler API, so TS 7 does not block the build. Config: `format: "esm"`, `dts: true`, `fixedExtension: false`.
- `node test/smoke.mjs` imports `dist/index.js` and passes on plain Node 24. The package self-import `@friday-friday/core` resolves to `dist` by default, and to `src/index.ts` under `--conditions=@friday-friday/source`.
- The CI job `size` re-runs the build and the smoke on every PR.

**Correction (2026-11-19, #44 decision 1, #63).** The 2026-11-16 note also said "the `src/*.ts` files also run directly under Node 24 type stripping". That held only for a single-file package. Once core had several modules, `node --conditions=@friday-friday/source -e "import('@friday-friday/core')"` failed with `ERR_MODULE_NOT_FOUND …/core/src/internal.js`: Node's type stripping does not read tsconfig, so it neither maps `./internal.js` to `./internal.ts` nor applies `paths`. Eric chose to keep the claim and make it true:

- Relative specifiers name the file on disk: `./internal.ts`, in `src` and `test` alike (one rule; `core/test/wire-golden.ts` is itself a source-condition export). `tsconfig.base.json` sets `rewriteRelativeImportExtensions`, which is all TS 6.0 / 7.0 / 7.1-beta need to accept `.ts` specifiers (`allowImportingTsExtensions` is not required). The repo never emits with `tsc` (`noEmit`), so the rewrite itself is inert today; it is there so the specifiers typecheck, and so a future `tsc` emit would still write `.js`.
- tsdown output is unchanged: rolldown names its own chunks (`./src-*.js`) and the dts bundler writes `./index.js` in `.d.ts`. Every `packages/*/dist` file was byte-identical before and after the specifier change.
- **Gate:** `pnpm run smoke:source` (`tooling/gates/src/source-smoke.ts`, after `pnpm run smoke` in `pnpm run ci` and in the CI `size` job). For every `packages/*` export entry with an `@friday-friday/source` target, a child plain Node 24 (no loader, no tsconfig) imports `<name><subpath>` with `--conditions=@friday-friday/source` from the package's directory, and the module must export exactly the names the built `default` target exports. `tooling/gates` fails when a built entry has no source target, when an exclusion names no package or gives no reason, or when a relative `.js` specifier for a `.ts` file comes back.

What the source condition guarantees: for every package except the excluded ones, each public entry (and core's `./test/wire-golden`) loads from `src/*.ts` under plain Node 24 type stripping, its whole suite graph (core, schema) loads from `src` too, its framework peers resolve as installed, and it exposes the same export names as `dist`. It does not guarantee the same behaviour as `dist` (the dist smokes and vitest cover that), and it does not reproduce `@friday-friday/next`'s `react-server`/`default` split: the source condition is listed first, so it wins over both.

Excluded: `@friday-friday/next`. next@16.4 ships no `exports` map, so plain Node ESM cannot resolve the `next/navigation` (root) and `next/error` (`/client`) subpaths its src imports at load time (`ERR_MODULE_NOT_FOUND …/node_modules/next/navigation`). Its dist smoke stubs those two modules; vitest and `examples/next-app` (`next build`) cover the source.
