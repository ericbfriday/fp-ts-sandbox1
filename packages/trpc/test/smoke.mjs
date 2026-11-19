// ADR-0002 gate for @friday-friday/trpc: built ESM output loads under plain Node 24, and the
// published types depend only on stable tRPC entry points (#57). Anything under
// `@trpc/server/unstable-core-do-not-import` (or any other non-root subpath) can change in a
// tRPC minor release and break consumers' builds.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { errorFormatter, fromTRPC, resultMiddleware, sanitize } from "../dist/index.js"

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

assert.equal(typeof resultMiddleware({}), "function")
assert.equal(typeof errorFormatter, "function")
assert.equal(typeof fromTRPC, "function")
assert.equal(typeof sanitize, "function")

// The built formatter masks a defect (core /wire envelope bundled correctly, #38).
const formatted = errorFormatter()({
  shape: { message: "postgres://admin:secret@db", data: {} },
  error: { code: "INTERNAL_SERVER_ERROR", cause: new Error("postgres://admin:secret@db") }
})
assert.equal(formatted.message, "Internal server error")
assert.deepEqual(formatted.data.friday_friday, { _tag: "InternalDefect", message: "Internal server error" })

process.stdout.write("trpc dist smoke: ok\n")
