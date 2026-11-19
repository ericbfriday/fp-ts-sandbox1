// ADR-0002 gate for @friday-friday/tanstack-start: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), [
  "formErrorMap",
  "loaderResult",
  "resultHandler",
  "resultServerFn",
  "toFormErrors"
])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

assert.equal(await mod.loaderResult({ ok: true, value: "data" }), "data")

process.stdout.write("tanstack-start dist smoke: ok\n")
