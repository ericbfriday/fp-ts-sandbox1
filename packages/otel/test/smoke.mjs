// ADR-0002 gate for @friday-friday/otel: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), ["ERROR_TAG_ATTR", "traced", "tracedSync"])
assert.equal(typeof mod.traced, "function")
assert.equal(typeof mod.tracedSync, "function")
assert.equal(typeof mod.ERROR_TAG_ATTR, "string")

// With no tracer provider registered, @opentelemetry/api hands out no-op spans.
assert.deepEqual(mod.tracedSync("smoke", () => ({ ok: true, value: 1 })), { ok: true, value: 1 })
assert.deepEqual(await mod.traced("smoke", async () => ({ ok: false, error: { _tag: "Nope" } })), {
  ok: false,
  error: { _tag: "Nope" }
})

process.stdout.write("otel dist smoke: ok\n")
