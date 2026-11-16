# ADR 0004 — Test, type-matrix and CI stack

Status: Accepted · Date: 2026-11-16

## Decision

- **Unit/property tests:** Vitest. Type tests via `vitest --typecheck` + `expectTypeOf`. No tsd / ts-morph (old compiler API).
- **Type matrix:** `typescript@6.0`, `7.0` (latest), `7.1` (`beta` tag until ~24 Nov 2026) installed as npm aliases; typecheck job runs the matrix.
- **Module resolution:** `moduleResolution: "bundler"` + `module: "esnext"` in tsconfig.base — NodeNext cannot resolve `next@16.4.6` subpaths (next ships an empty `exports` map), and bundler supports the workspace `customConditions` (`@friday-friday/source`). See PR #15.
- **Property laws:** fast-check — functor/monad laws, dual-form equivalence, JSON round-trip, `structuredClone` stability (RFC 0001 §5).
- **Size budgets:** size-limit in CI — `import { ok, err, map, andThen, pipe }` ≤ 600 B min+gz; full core ≤ 3 kB; each adapter ≤ 2 kB excluding peers.
- **Type-instantiation budget:** `tsc --extendedDiagnostics` on fixture files; fail if instantiations regress > 20%. Deferred until Phase 3 creates the TS2589 budget fixtures (no fixtures exist yet); tracked as part of the `hono`/`trpc` phase.
- **CI:** GitHub Actions — install (pnpm, frozen lockfile), lint, typecheck matrix, test, size-limit. Publish steps intentionally absent (no npm publishing without Eric).
- **Runtime matrix for examples** (Node, Bun, Deno, wrangler) is a later-phase job; CI starts Node-24-only.
