// ADR-0002 gate for @friday-friday/trpc: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), [
  "TRPCTransportError",
  "err",
  "errorFormatter",
  "fromTRPC",
  "ok",
  "resultMiddleware",
  "resultProcedure",
  "sanitize",
  "taggedError"
])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const NotFound = mod.taggedError("NotFound")()
assert.deepEqual(mod.sanitize(NotFound({ id: "1", cause: new Error("db") })), { _tag: "NotFound", id: "1" })
assert.deepEqual(await mod.fromTRPC(Promise.resolve(1)), { ok: true, value: 1 })

process.stdout.write("trpc dist smoke: ok\n")
