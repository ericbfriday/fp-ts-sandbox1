// ADR-0002 gate for @friday-friday/effect: built ESM output loads and runs under plain Node 24.
import { Effect } from "effect"
import assert from "node:assert/strict"
import * as mod from "../dist/index.js"

assert.deepEqual(Object.keys(mod).sort(), ["fromExit", "runResult", "toEffect"])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

assert.deepEqual(await mod.runResult(Effect.succeed(1)), { ok: true, value: 1 })
assert.deepEqual(await mod.runResult(Effect.fail("nope")), { ok: false, error: "nope" })
assert.deepEqual(await mod.runResult(mod.toEffect({ ok: true, value: 2 })), { ok: true, value: 2 })

process.stdout.write("effect dist smoke: ok\n")
