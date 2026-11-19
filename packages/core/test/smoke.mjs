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
  toPanic,
  toThrowable
} from "../dist/index.js"
import { allAsync, mapAsync, retry, timeout, tryAsync } from "../dist/async.js"
import { $, gen } from "../dist/gen.js"
import { fromWire, PROBLEM_CONTENT_TYPE, sanitize, toDefect, toProblem } from "../dist/wire.js"

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
const existing = new Panic({ dsn: "postgres://admin:hunter2@db" })
assert.equal(existing.message, "Non-Error thrown") // never the object's data
assert.equal(toPanic(existing), existing)
const { proxy, revoke } = Proxy.revocable({}, {})
revoke()
assert.equal(toPanic(proxy).message, "Unprintable thrown value") // total

// /async subpath (dist/async.js)
const asyncOk = await mapAsync(Promise.resolve(ok(2)), async (n) => n * 10)
assert.deepEqual(asyncOk, { ok: true, value: 20 })
await assert.rejects(mapAsync(ok(1), async () => { throw new Error("boom") }), (e) => e instanceof Panic)
assert.deepEqual(await allAsync([async () => ok(1), async () => ok(2)]), ok([1, 2]))
assert.deepEqual(await retry(async () => err("nope"), { times: 2, delay: 1 }), err("nope"))
assert.deepEqual(await timeout(async () => ok("fast"), 1000), ok("fast"))
assert.deepEqual(
  await tryAsync(async () => { throw "boom" }, { catch: (c) => `m:${String(c)}` }),
  err("m:boom")
)

// /gen subpath (dist/gen.js)
const genResult = gen(function* () {
  const a = yield* $(ok(1))
  const b = yield* $(ok(2))
  return a + b
})
assert.deepEqual(genResult, ok(3))

// /wire subpath (dist/wire.js)
const nf = NotFound({ resource: "user", id: "1", message: "gone", big: 1n, cause: new Error("db") })
assert.deepEqual(sanitize(nf), { _tag: "NotFound", resource: "user", id: "1", message: "gone" })
const problem = toProblem(nf)
assert.deepEqual(problem, {
  type: "https://friday-friday.dev/errors/not-found",
  title: "Not Found",
  status: 404,
  detail: "gone",
  tag: "NotFound",
  resource: "user",
  id: "1"
})
assert.deepEqual(fromWire(JSON.parse(JSON.stringify(problem))), sanitize(nf))
assert.deepEqual(toProblem(fromWire(problem), problem.status), problem)
assert.deepEqual(toDefect(new Error("postgres://admin:hunter2@db")), { _tag: "InternalDefect", message: "Internal server error" })
assert.equal(toProblem(toDefect("boom")).status, 500)
assert.equal(PROBLEM_CONTENT_TYPE, "application/problem+json")
// RFC-0001 §6: a tag with no status is masked as the defect envelope; the original is reported.
const reported = []
const masked = toProblem({ _tag: "DbUnavailable", host: "db.internal:5432" }, {}, { report: (c) => reported.push(c) })
assert.deepEqual(masked, toProblem(toDefect("x")))
assert.equal(reported[0].host, "db.internal:5432")
assert.equal(toProblem(nf, { Conflict: 409 }).status, 404)
assert.equal(toProblem(nf, { Conflict: 409 }, { strict: true }).tag, "InternalDefect")
assert.deepEqual(sanitize(nf, { safeProps: ["id"] }), { _tag: "NotFound", id: "1", message: "gone" })

process.stdout.write("core dist smoke: ok\n")
