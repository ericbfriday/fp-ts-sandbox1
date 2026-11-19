// ADR-0002 gate for @friday-friday/hono: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import { Hono } from "hono"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), ["onErrorHandler", "problem", "respond", "sv"])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const app = new Hono()
app.get("/ok", (c) => mod.respond(c, { ok: true, value: { id: 1 } }, {}))
app.get("/missing", (c) => mod.respond(c, { ok: false, error: { _tag: "NotFound", id: "1" } }, { NotFound: 404 }))
const okRes = await app.request("/ok")
assert.equal(okRes.status, 200)
assert.deepEqual(await okRes.json(), { id: 1 })
const missing = await app.request("/missing")
assert.equal(missing.status, 404)
assert.equal(missing.headers.get("content-type"), "application/problem+json")
assert.equal((await missing.json()).tag, "NotFound")

process.stdout.write("hono dist smoke: ok\n")
