// ADR-0002 gate for @friday-friday/db: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import { Conflict, DbUnavailable } from "@friday-friday/core"
import * as mod from "../dist/index.js"

// Conflict / NotFound / DbUnavailable are core's factories (ADR-0005): db exports none of its own.
assert.deepEqual(Object.keys(mod).sort(), [
  "ForeignKeyViolation",
  "NotNullViolation",
  "mapDbError",
  "mapPgError",
  "mapPrismaError"
])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

const unique = mod.mapPgError({ code: "23505", constraint: "users_email_key", detail: "Key (email)=(a@b.c)" })
assert.equal(unique._tag, "Conflict")
assert.equal(unique.constraint, "users_email_key")
assert.ok(Conflict.is(unique))
const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
  errno: -111,
  code: "ECONNREFUSED",
  syscall: "connect",
  address: "10.0.0.5",
  port: 5432
})
const down = mod.mapDbError(new Error("wrapped", { cause: refused }))
assert.ok(DbUnavailable.is(down))
assert.deepEqual(Object.keys(down), ["_tag", "cause"])
assert.equal(mod.mapPrismaError({ errorCode: "P1001" })?._tag, "DbUnavailable")
assert.equal(mod.mapDbError(new Error("not a driver error")), null)

process.stdout.write("db dist smoke: ok\n")
