// ADR-0002 gate for next's dist. next@16.4 ships no `exports` map, so plain Node cannot resolve
// `next/*` from ESM: those two modules are stubbed (in-thread resolve hook) and EVERYTHING ELSE
// is real, including the `react-server` condition, which runs in a child Node with
// `--conditions=react-server` (#53).
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

const stubs = {
  "next/error": "export const catchError = (f) => f",
  "next/navigation":
    "const no = () => { throw new Error('stub') }; export const forbidden = no, notFound = no, redirect = no, unstable_rethrow = () => {}"
}
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier in stubs
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
      : nextResolve(specifier, context)
})

const reactServer = process.argv[2] === "react-server"

if (reactServer) {
  // The server graph: the root loads, and /client refuses to (client-only's react-server entry).
  const root = await import("../dist/index.js")
  for (const name of ["action", "orNotFound", "orForbidden", "orRedirect", "toResponse", "tryAsync", "toThrowable"]) {
    assert.equal(typeof root[name], "function", name)
  }
  assert.equal("orThrow" in root, false, "orThrow is client-only (#53)")
  await assert.rejects(import("../dist/client.js"), /cannot be imported from a Server Component/)
} else {
  // 1. The guard survives the build: tsdown must keep the side-effect import (#53).
  const client = readFileSync(new URL("../dist/client.js", import.meta.url), "utf8")
  assert.match(client, /^import "client-only";$/m, "dist/client.js must import client-only")

  // 2. Default condition: /client loads; the root entry is the throwing server-only stub.
  const mod = await import("../dist/client.js")
  assert.equal(typeof mod.resultBoundary, "function")
  assert.equal(mod.orThrow({ ok: true, value: 1 }), 1)
  assert.throws(() => mod.orThrow({ ok: false, error: { _tag: "NotFound" } }), { name: "NotFound" })
  await assert.rejects(import("../dist/server-only-stub.js"), /root entry is server-only/)

  // 3. Same dist under the react-server condition (this file again, in a child Node).
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", fileURLToPath(import.meta.url), "react-server"],
    { encoding: "utf8" }
  )
  assert.equal(child.status, 0, child.stderr)
}
