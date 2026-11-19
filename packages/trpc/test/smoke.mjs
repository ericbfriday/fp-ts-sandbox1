// ADR-0002 gate for @friday-friday/trpc: built ESM output loads under plain Node 24, and the
// published types depend only on stable tRPC entry points (#57). Anything under
// `@trpc/server/unstable-core-do-not-import` (or any other non-root subpath) can change in a
// tRPC minor release and break consumers' builds.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import * as mod from "../dist/index.js"

const dts = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")
const specifiers = [...dts.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)]
  .map((m) => m[1] ?? m[2])
const trpcSpecifiers = specifiers.filter((s) => s.startsWith("@trpc/"))
assert.ok(trpcSpecifiers.length > 0, "expected dist/index.d.ts to reference @trpc/server")
assert.deepEqual(
  trpcSpecifiers.filter((s) => s !== "@trpc/server"),
  [],
  `dist/index.d.ts must import only the stable "@trpc/server" root; found: ${trpcSpecifiers.join(", ")}`
)
assert.equal(dts.includes("unstable-core-do-not-import"), false)

// Every value export exists (#43).
assert.deepEqual(Object.keys(mod).sort(), [
  "TRPCTransportError",
  "err",
  "errorFormatter",
  "fromTRPC",
  "ok",
  "resultMiddleware",
  "resultProcedure",
  "sanitize",
  "taggedError"
])
for (const value of Object.values(mod)) assert.equal(typeof value, "function")

assert.equal(typeof mod.resultMiddleware({}), "function")
const NotFound = mod.taggedError("NotFound")()
assert.deepEqual(mod.sanitize(NotFound({ id: "1", cause: new Error("db") })), { _tag: "NotFound", id: "1" })
assert.deepEqual(await mod.fromTRPC(Promise.resolve(1)), { ok: true, value: 1 })

process.stdout.write("trpc dist smoke: ok\n")
