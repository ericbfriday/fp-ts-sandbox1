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
- `node test/smoke.mjs` imports `dist/index.js` and passes on plain Node 24. The package self-import `@friday-friday/core` resolves to `dist` by default, and to `src/index.ts` under `--conditions=@friday-friday/source`. The `src/*.ts` files also run directly under Node 24 type stripping.
- The CI job `size` re-runs the build and the smoke on every PR.
