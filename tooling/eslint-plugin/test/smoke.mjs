// ADR-0002 dist smoke for @friday-friday/eslint-plugin (#106): the built ESM loads under plain
// Node 24 with no TypeScript, ESLint or typescript-eslint import at runtime, and exposes the
// three rules with their metadata.
import assert from "node:assert/strict"

const mod = await import("../dist/index.js")
assert.deepEqual(Object.keys(mod), ["default"])
const plugin = mod.default
assert.equal(plugin.meta.name, "@friday-friday/eslint-plugin")
assert.deepEqual(Object.keys(plugin.rules).sort(), [
  "must-use-result",
  "no-instanceof-tagged-error",
  "no-try-around-redirect"
])
for (const rule of Object.values(plugin.rules)) {
  assert.equal(typeof rule.create, "function")
  assert.equal(rule.meta.type, "problem")
}
