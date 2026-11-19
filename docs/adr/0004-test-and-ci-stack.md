# ADR 0004 — Test, type-matrix and CI stack

Status: Accepted · Date: 2026-11-16

## Decision

- **Unit/property tests:** Vitest. Type tests via `vitest --typecheck` + `expectTypeOf`. No tsd / ts-morph (old compiler API).
- **Type matrix:** `typescript@6.0`, `7.0` (latest), `7.1` (`beta` tag until ~24 Nov 2026) installed as npm aliases; typecheck job runs the matrix.
- **Module resolution:** `moduleResolution: "bundler"` + `module: "esnext"` in tsconfig.base — NodeNext cannot resolve `next@16.4.6` subpaths (next ships an empty `exports` map), and bundler supports the workspace `customConditions` (`@friday-friday/source`). See PR #15.
- **Property laws:** fast-check — functor/monad laws, dual-form equivalence, JSON round-trip, `structuredClone` stability (RFC 0001 §5).
- **Size budgets:** size-limit in CI — `import { ok, err, map, andThen, pipe }` ≤ 600 B min+gz; full core ≤ 3 kB; each adapter ≤ 2 kB excluding peers.
- **Type-instantiation budget:** `tsc --extendedDiagnostics` on fixture files; fail if instantiations regress > 20%. Fixture: `tooling/type-budget/fixture/core-stress.ts` (15-step `andThen` pipe, 15-tag `matchTag` in both forms, 12-tuple `all`, 11-step `flow`), measured as its instantiations minus `core-baseline.ts`'s so core's own growth and lib bumps don't move it. `tooling/type-budget/budget.json` records `measured` and `ceiling` (≤ measured + 20%) per TypeScript major.minor, because 6.0 and 7.x count differently (3,694 vs 3,877 on 6.0.3 / 7.0.2 / 7.1.0-beta). `pnpm run check` ends with `node tooling/type-budget/src/check.ts`, so the typecheck matrix runs it on every TS version, and it fails when the cost passes the ceiling or the running version has none (issue #61). Adapter fixtures (hono `hc`, tRPC routers) are not in it yet.
- **CI:** GitHub Actions — install (pnpm, frozen lockfile), lint, typecheck matrix, test, size-limit, then a plain-Node dist smoke (`pnpm run smoke`, the ADR-0002 gate) and the source-condition smoke (`pnpm run smoke:source`, ADR-0002, #63). Publish steps intentionally absent (no npm publishing without Eric). `pnpm run ci` runs the same gates locally (typecheck on TS 7 only).
- **Runtime matrix for examples** (Node, Bun, Deno, wrangler) is a later-phase job; CI starts Node-24-only.
