// ADR-0002 gate for @friday-friday/env: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import { z } from "zod"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), ["envRecord", "parseEnv"])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const Env = z.object({ PORT: z.coerce.number() })
assert.deepEqual(mod.parseEnv(Env, { PORT: "3000" }), { ok: true, value: { PORT: 3000 } })
const bad = mod.parseEnv(z.object({ API_KEY: z.string().startsWith("pk_") }), { API_KEY: "sk_live_secret" })
assert.equal(bad.error._tag, "ValidationFailure")
assert.equal(JSON.stringify(bad.error).includes("sk_live_secret"), false)

process.stdout.write("env dist smoke: ok\n")
