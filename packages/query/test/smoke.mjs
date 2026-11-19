// ADR-0002 gate for @friday-friday/query: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), ["resultQueryOptions", "retryUnless", "toQueryFn"])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const signal = new AbortController().signal
const queryFn = mod.toQueryFn(async () => ({ ok: true, value: 1 }))
assert.equal(await queryFn({ signal }), 1)
await assert.rejects(mod.toQueryFn(async () => ({ ok: false, error: { _tag: "NotFound" } }))({ signal }), { _tag: "NotFound" })

process.stdout.write("query dist smoke: ok\n")
