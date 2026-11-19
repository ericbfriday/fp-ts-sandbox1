/**
 * What React Flight sends to the browser for an error thrown in a Server Component (#53, Design
 * Report §5.1 "Client", RFC-0001 §2).
 *
 * Runs the REAL server renderer Next 16.4.6 ships (`next/dist/compiled/react-server-dom-webpack`,
 * `renderToPipeableStream`), aliased to Next's compiled `react-server` React the way Next's own
 * require hook does. The two error writers under test:
 * - production `emitErrorChunk(request, id, digest)` writes only `{ digest }`;
 * - development `emitErrorChunk` writes `{ digest, name, message, stack, env, owner }` plus
 *   `cause` whenever `"cause" in error` (enumerable or not), and never any other own property.
 * So `toThrowable`'s `data` never reaches the client, and a `cause` on the thrown Error would.
 */
import { taggedError, toThrowable } from "@friday-friday/core"
import { createRequire, registerHooks } from "node:module"
import { dirname, join } from "node:path"
import { Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

type Mode = "development" | "production"

const require = createRequire(import.meta.url)
const compiled = join(dirname(require.resolve("next/package.json")), "dist", "compiled")

/** Next's own aliasing: inside its compiled bundles, `react`/`react-dom` mean the react-server builds. */
const reactServer = (mode: Mode): Record<string, string> => {
  const react = join(compiled, "react", "cjs", `react.react-server.${mode}.js`)
  const dom = join(compiled, "react-dom", "cjs", `react-dom.react-server.${mode}.js`)
  return { react, "react-dom": dom, "next/dist/compiled/react": react, "next/dist/compiled/react-dom": dom }
}

let mode: Mode = "development"
const hooks = registerHooks({
  resolve: (specifier, context, nextResolve) => {
    const target = context.parentURL?.includes("/next/dist/compiled/") ? reactServer(mode)[specifier] : undefined
    return target ? { url: pathToFileURL(target).href, shortCircuit: true } : nextResolve(specifier, context)
  }
})
afterAll(() => hooks.deregister())

interface Flight {
  readonly renderToPipeableStream: (
    model: unknown,
    config: unknown,
    options: { readonly onError: () => string }
  ) => { pipe: (w: Writable) => void }
}
interface ReactServer {
  readonly createElement: (type: () => never) => unknown
}

/** The Flight payload of a page whose only component throws `thrown`. */
const flightPayload = (m: Mode, thrown: unknown): Promise<string> => {
  mode = m
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vendor CJS bundle, shape documented above
  const flight = require(
    join(compiled, "react-server-dom-webpack", "cjs", `react-server-dom-webpack-server.node.${m}.js`)
  ) as Flight
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vendor CJS bundle
  const react = require(reactServer(m)["react"]!) as ReactServer
  const Page = (): never => {
    throw thrown
  }
  return new Promise((resolve) => {
    let out = ""
    const sink = new Writable({
      write: (chunk: Buffer, _enc, done) => {
        out += String(chunk)
        done()
      },
      final: (done) => {
        resolve(out)
        done()
      }
    })
    flight.renderToPipeableStream(react.createElement(Page), {}, { onError: () => "DIGEST" }).pipe(sink)
  })
}

/** The `:E` (error) row of a Flight payload, parsed. */
const errorRow = (payload: string): Record<string, unknown> => {
  const row = payload.split("\n").find((l) => /^[0-9a-f]+:E/.test(l)) ?? ""
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the row is a JSON object by the Flight protocol
  return JSON.parse(row.slice(row.indexOf(":E") + 2)) as Record<string, unknown>
}

const NotFound = taggedError("NotFound")<{ id: string }>()
const secret = { password: "hunter2" }
const thrown = (): Error => toThrowable(NotFound({ id: "1", message: "no such user", cause: secret }))

describe("React Flight error serialization (next 16.4.6 compiled react-server-dom-webpack)", () => {
  it("production sends only the digest: no name, message or tagged data reaches the client", async () => {
    const payload = await flightPayload("production", thrown())
    expect(errorRow(payload)).toEqual({ digest: "DIGEST" })
    expect(payload).not.toContain("NotFound")
    expect(payload).not.toContain("hunter2")
  })

  it("development sends name/message/stack but never toThrowable's data, and no cause", async () => {
    const payload = await flightPayload("development", thrown())
    const row = errorRow(payload)
    expect(row).toMatchObject({ digest: "DIGEST", name: "NotFound", message: "no such user" })
    expect(Object.keys(row).sort()).toEqual(["digest", "env", "message", "name", "owner", "stack"])
    expect(payload).not.toContain("hunter2")
  })

  it("development does send an Error's cause, even a non-enumerable one (why toThrowable sets none)", async () => {
    const e = new Error("boom", { cause: secret })
    expect(Object.keys(e)).not.toContain("cause")
    const payload = await flightPayload("development", e)
    expect(errorRow(payload)).toHaveProperty("cause")
    expect(payload).toContain("hunter2")
  })
})
