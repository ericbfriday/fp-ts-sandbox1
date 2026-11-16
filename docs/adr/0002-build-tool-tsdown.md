# ADR 0002 — Build tool: tsdown, ESM-only

Status: Accepted (verification gate in scaffold task) · Date: 2026-11-16

## Context

Design Report §6: builds should use tsdown (Rolledown-based), ESM-only, with `.d.ts` emitted under `isolatedDeclarations`. TypeScript 7 (Go) has no programmatic compiler API until 7.1, so build tooling must not depend on the old `ts` API surface.

## Decision

**tsdown** per package, ESM-only output, `dts: true` via isolatedDeclarations. `sideEffects: false` everywhere. Conditional `exports` per package (e.g. `react-server`/`default` for `@friday-friday/next`); `workerd`/`edge-light` only where code truly differs.

## Verification gate

The scaffold task must prove on this machine: `tsdown build` for a trivial package emits `dist/*.js` + `dist/*.d.ts`, and the output runs under Node 24 type-stripping. If tsdown × TS 7 fails, fall back to `tsc --build` + `rolldown` and record it here.
