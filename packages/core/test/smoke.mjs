// ADR-0002 gate: the built ESM output must load and run under plain Node 24.
import assert from "node:assert/strict"
import {
  all,
  andThen,
  err,
  fromNullable,
  isResult,
  map,
  matchTag,
  ok,
  Panic,
  pipe,
  taggedError,
  toThrowable
} from "../dist/index.js"

const NotFound = taggedError("NotFound")()

const r = pipe(ok(1), map((n) => n + 1), andThen((n) => n > 1 ? ok(n) : err("small")))
assert.deepEqual(r, { ok: true, value: 2 })
assert.deepEqual(structuredClone(err("e")), { ok: false, error: "e" })
assert.equal(isResult(JSON.parse(JSON.stringify(r))), true)

const missing = fromNullable(undefined, () => NotFound({ resource: "user", id: "1" }))
assert.equal(NotFound.is(JSON.parse(JSON.stringify(missing)).error), true)
assert.equal(matchTag(missing, { ok: () => "ok", NotFound: (e) => e.id }), "1")
assert.equal(toThrowable(missing.error).name, "NotFound")
assert.deepEqual(all([ok(1), ok(2)]), ok([1, 2]))

assert.throws(() => map(ok(1), () => { throw new Error("boom") }), (e) => e instanceof Panic && e.cause.message === "boom")

process.stdout.write("core dist smoke: ok\n")
