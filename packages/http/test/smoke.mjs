// ADR-0002 gate for @friday-friday/http: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), ["HttpError", "fetchResult", "reconstruct"])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const rebuilt = mod.reconstruct({ type: "about:blank", title: "Not Found", status: 404, detail: "gone", tag: "NotFound", id: "1" })
assert.equal(rebuilt._tag, "NotFound")
assert.equal(rebuilt.id, "1")
assert.equal(mod.reconstruct(undefined), null)
const offline = await mod.fetchResult("http://127.0.0.1:1/unreachable", { retries: 0 })
assert.equal(offline.ok, false)
assert.equal(offline.error._tag, "NetworkError") // core's fixed tag (ADR-0005, #90)
assert.equal(typeof offline.error.reason, "string")

process.stdout.write("http dist smoke: ok\n")
