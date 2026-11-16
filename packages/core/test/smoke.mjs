// ADR-0002 gate: the built ESM output must load and run under plain Node 24.
import assert from "node:assert/strict"
import { andThen, err, map, ok, pipe } from "../dist/index.js"

const r = pipe(ok(1), (x) => andThen(map(x, (n) => n + 1), (n) => n > 1 ? ok(n) : err("small")))
assert.deepEqual(r, { ok: true, value: 2 })
assert.deepEqual(structuredClone(err("e")), { ok: false, error: "e" })
process.stdout.write("core dist smoke: ok\n")
