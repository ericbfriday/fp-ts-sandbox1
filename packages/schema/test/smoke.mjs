// ADR-0002 gate for @friday-friday/schema: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import { ok } from "@friday-friday/core"
import { branded, parse, parseAsync, toFieldErrors, toFormErrors } from "../dist/index.js"
import { z } from "zod"

const User = z.object({ id: z.string() })
assert.deepEqual(parse(User, { id: "u1" }), ok({ id: "u1" }))
const failing = parse(User, { id: 1 })
assert.equal(failing.ok, false)
if (!failing.ok) assert.equal(failing.error._tag, "ValidationFailure")

const parseId = branded(User, "UserId")
assert.deepEqual(parseId({ id: "u-9" }), ok({ id: "u-9" }))

const fields = toFieldErrors(failing.ok ? ok(1) : failing.error)
assert.ok(fields !== undefined)
const form = toFormErrors(failing.ok ? ok(1) : failing.error)
assert.ok(form !== undefined)

assert.ok(typeof parseAsync === "function")

process.stdout.write("schema dist smoke: ok\n")
