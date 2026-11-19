// ADR-0002 gate for @friday-friday/db: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), [
  "Conflict",
  "ForeignKeyViolation",
  "NotFound",
  "NotNullViolation",
  "mapDbError",
  "mapPgError",
  "mapPrismaError"
])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const unique = mod.mapPgError({ code: "23505", constraint: "users_email_key", detail: "Key (email)=(a@b.c)" })
assert.equal(unique._tag, "Conflict")
assert.equal(unique.constraint, "users_email_key")
assert.equal(mod.mapDbError(new Error("not a driver error")), null)

process.stdout.write("db dist smoke: ok\n")
