// ADR-0002 gate for @friday-friday/schema: built ESM output loads and runs under plain Node 24.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { err, ok, Panic } from "@friday-friday/core"
import * as dist from "../dist/index.js"
import { z } from "zod"

const { branded, parse, parseAsync, toFieldErrors, toFormErrors, toValidationFailure, ValidationFailure } = dist

// Every VALUE export the .d.ts promises must exist at runtime (#32: `brand` was a
// `declare const` value export that type-checked but was a SyntaxError on import).
const dts = readFileSync(new URL("../dist/index.d.ts", import.meta.url), "utf8")
const declared = [...dts.matchAll(/^export declare (?:const|let|var|function|class|enum) (\w+)/gm)].map((m) => m[1])
for (const list of dts.matchAll(/^export \{([^}]*)\}/gm)) {
  for (const spec of list[1].split(",")) {
    const name = spec.trim().split(/\s+as\s+/).at(-1)
    if (name !== undefined && name !== "" && !spec.trim().startsWith("type ")) declared.push(name)
  }
}
assert.ok(declared.length > 0, "no value exports found in dist/index.d.ts")
for (const name of declared) assert.ok(name in dist, `.d.ts declares value export \`${name}\` missing at runtime`)

const User = z.object({ id: z.string() })
assert.deepEqual(parse(User, { id: "u1" }), ok({ id: "u1" }))
const failing = parse(User, { id: 1 })
assert.equal(failing.ok, false)
if (!failing.ok) assert.equal(failing.error._tag, "ValidationFailure")

// The one producer: parse emits exactly the projection; root issues get `path: []`.
assert.deepEqual(
  toValidationFailure([{ message: "root", input: "secret" }]),
  ValidationFailure({ issues: [{ message: "root", path: [] }] })
)

const parseId = branded(User, "UserId")
assert.deepEqual(parseId({ id: "u-9" }), ok({ id: "u-9" }))

if (!failing.ok) {
  assert.deepEqual(Object.keys(toFieldErrors(failing.error)), ["id"])
  assert.deepEqual(Object.keys(toFormErrors(failing.error)), ["_errors", "id"])
}
assert.deepEqual(toFieldErrors({ issues: [{ message: "from the wire" }] }), { _errors: ["from the wire"] })

assert.deepEqual(await parseAsync(User, { id: 2 }), err(failing.ok ? undefined : failing.error))
const throwing = { "~standard": { version: 1, vendor: "smoke", validate: () => { throw new Error("boom") } } }
await assert.rejects(parseAsync(throwing, null), (e) => e instanceof Panic)

process.stdout.write("schema dist smoke: ok\n")
