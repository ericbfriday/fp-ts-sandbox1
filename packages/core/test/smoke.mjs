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
import { allAsync, mapAsync, retry, timeout, tryAsync } from "../dist/async.js"

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

// /async subpath (dist/async.js)
const asyncOk = await mapAsync(Promise.resolve(ok(2)), async (n) => n * 10)
assert.deepEqual(asyncOk, { ok: true, value: 20 })
assert.deepEqual(await allAsync([async () => ok(1), async () => ok(2)]), ok([1, 2]))
assert.deepEqual(await retry(async () => err("nope"), { times: 2, delay: 1 }), err("nope"))
assert.deepEqual(await timeout(async () => ok("fast"), 1000), ok("fast"))
assert.deepEqual(
  await tryAsync(async () => { throw "boom" }, { catch: (c) => `m:${String(c)}` }),
  err("m:boom")
)

process.stdout.write("core dist smoke: ok\n")
