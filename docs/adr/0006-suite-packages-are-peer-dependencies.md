# ADR 0006 — Core and schema are peer dependencies; Panic is recognised by a brand

Status: Accepted · Date: 2026-11-19 · Issue: #62 (Eric's #44 decision 2)

## Decision

Every package that imports another suite package lists it under `peerDependencies` with `workspace:^` (pnpm rewrites it to `^<version>` on pack), and under `devDependencies` with `workspace:*` for the workspace link, never under `dependencies`: schema and all adapters peer on `@friday-friday/core`, and env, hono, http, next, tanstack-start and trpc also peer on `@friday-friday/schema`. An app installs core once and every adapter shares it, so adapter size budgets measure only the adapter's own code (`.size-limit.json` `ignore`, #82). Version skew can still load two copies of core, and `instanceof` fails across them (the IDEA §4.2 hazard for tagged errors). So `Panic` carries a non-enumerable `Symbol.for("@friday-friday/core/Panic")` brand, core exports a structural `isPanic(u)`, and `toPanic` uses it, so a Panic from another copy is not wrapped again. `tooling/gates` checks the manifests; `packages/core/test/panic-brand.test.ts` and core's dist smoke check the brand across two module instances.

## Considered options

- **Keep core under `dependencies`.** Rejected: on skew each adapter gets its own copy of core, the app bundles core several times, and `instanceof Panic` stops matching.
- **`workspace:*` peers** (an exact pin on pack). Rejected: it forces every adapter to the same patch of core. `workspace:^` does the same at 0.0.x anyway (`^0.0.0` matches 0.0.0 only), so release core and the adapters together while the suite is 0.x.
- **Brand by `name === "Panic"`.** Rejected: any `Error` can set `name`, and a `structuredClone`d Panic would pass.

## Consequences

- An app lists `@friday-friday/core` (and `@friday-friday/schema` when an adapter needs it) itself. pnpm and npm 7+ install missing peers by default.
- Code outside core must recognise a Panic with `isPanic`, never `instanceof Panic`. Tests may still use `instanceof` where they assert the class.
- `tooling/eslint-plugin` and `tooling/codemods` are unaffected. The plugin keeps core as a dev-only `workspace:*` link: its rules match type NAMES, so its published artifact imports no suite package (#106 made it publish-ready; its peers are `eslint` and `typescript-eslint`).
