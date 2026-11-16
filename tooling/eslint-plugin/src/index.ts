import type { ESLint, Rule } from "eslint"

/**
 * `@friday-friday/eslint-plugin` — local, type-aware rules (ADR-0003).
 *
 * Planned rules (issue #8): `must-use-result`, `no-try-around-redirect`,
 * `no-instanceof-tagged-error`. Written here, never pulled from third parties
 * (IDEA.md §8). They live in ESLint because Oxlint JS plugins cannot read type
 * information yet; revisit when they can.
 */
const rules: Record<string, Rule.RuleModule> = {}

const plugin: ESLint.Plugin = {
  meta: { name: "@friday-friday/eslint-plugin", version: "0.0.0" },
  rules
}

export default plugin
