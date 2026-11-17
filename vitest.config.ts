import { defineConfig, type ViteUserConfig } from "vitest/config"

/**
 * Root Vitest config (ADR-0004). One config for every workspace package — the
 * `projects` split can come later if packages need different environments.
 *
 * Source resolution: packages expose a `@friday-friday/source` export condition
 * that points at `src/*.ts`, so tests run against source without a build step.
 * tsconfig.base.json sets the same condition via `customConditions`.
 *
 * Type tests: `*.test-d.ts` files hold `expectTypeOf` assertions and run with
 * `vitest --typecheck` (`pnpm test` includes them). The checker shells out to
 * the `tsc` bin of whatever `typescript` is installed at the root. The CI
 * typecheck matrix swaps that package for npm aliases
 * (`typescript@npm:typescript@6.0` / `7.0` / `7.1.0-beta`), so the same
 * config covers TS 6.0 / 7.0 / 7.1 without per-version aliases in here.
 */
const config: ViteUserConfig = defineConfig({
  resolve: {
    conditions: ["@friday-friday/source"]
  },
  ssr: {
    resolve: {
      conditions: ["@friday-friday/source"]
    }
  },
  test: {
    include: ["{packages,tooling,examples}/*/test/**/*.test.ts", "tooling/codemods/test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      checker: "tsc",
      include: ["{packages,tooling,examples}/*/test/**/*.test-d.ts", "tooling/codemods/test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json"
    }
  }
})

export default config
