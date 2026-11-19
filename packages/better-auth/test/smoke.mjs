// ADR-0002 gate for @friday-friday/better-auth: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), [
  "AuthApiError",
  "Forbidden",
  "Unauthenticated",
  "authCall",
  "beforeDbHook",
  "fromAuthTuple",
  "requireRole",
  "requireSession"
])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const session = { user: { role: "user, admin" } }
assert.deepEqual(mod.requireRole("admin")(session), { ok: true, value: session })
assert.equal(mod.requireRole("owner")(session).error._tag, "Forbidden")
assert.equal(mod.fromAuthTuple({ data: null, error: { status: 401 } }).error._tag, "Unauthenticated")

process.stdout.write("better-auth dist smoke: ok\n")
