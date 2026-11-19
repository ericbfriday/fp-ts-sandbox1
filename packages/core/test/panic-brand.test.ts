/**
 * Panic's cross-copy brand (#62, Eric's #44 decision 2; IDEA §4.2).
 *
 * Version skew can load two copies of core into one app, and `instanceof` fails across them:
 * the hazard IDEA §4.2 avoids for tagged errors. A Panic therefore carries a non-enumerable
 * `Symbol.for("@friday-friday/core/Panic")` brand (the global symbol registry is shared by every
 * copy), `isPanic` checks it structurally, and `toPanic` uses `isPanic` for its idempotence.
 *
 * The second copy is core's source copied to a temp dir and imported from there: a separate module
 * graph, so a separate `Panic` class (the dist smoke repeats this against the built output).
 */
import type * as CoreModule from "@friday-friday/core"
import { isPanic, Panic, toPanic } from "@friday-friday/core"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

type Core = typeof CoreModule

const copyDir = mkdtempSync(join(tmpdir(), "friday-core-copy-"))
cpSync(join(import.meta.dirname, "..", "src"), copyDir, { recursive: true })
// oxlint-disable-next-line no-unsafe-type-assertion -- the copy is core's own source, so it has core's shape
const other = (await import(pathToFileURL(join(copyDir, "index.ts")).href)) as Core
afterAll(() => rmSync(copyDir, { recursive: true, force: true }))

const BRAND = Symbol.for("@friday-friday/core/Panic")

describe("Panic brand across two copies of core", () => {
  it("the second copy is a separate module instance: instanceof fails across it", () => {
    expect(other.Panic).not.toBe(Panic)
    expect(new other.Panic("x") instanceof Panic).toBe(false)
    expect(new Panic("x") instanceof other.Panic).toBe(false)
  })

  it("isPanic recognises a Panic from either copy", () => {
    expect(isPanic(new other.Panic("x"))).toBe(true)
    expect(other.isPanic(new Panic("x"))).toBe(true)
  })

  it("toPanic is idempotent across copies: a foreign copy's Panic is returned as the same instance", () => {
    const foreign = new other.Panic("x")
    expect(toPanic(foreign)).toBe(foreign)
    const local = new Panic("y")
    expect(other.toPanic(local)).toBe(local)
  })
})

describe("isPanic", () => {
  it("carries the registered-symbol brand, non-enumerable so it never serializes or spreads", () => {
    const p = new Panic("x")
    expect(Object.getOwnPropertySymbols(p)).toContain(BRAND)
    expect(Object.prototype.propertyIsEnumerable.call(p, BRAND)).toBe(false)
    // Spreading a Panic is exactly the hazard under test: an enumerable brand would survive it.
    // oxlint-disable-next-line no-misused-spread -- deliberately drops the prototype
    expect(isPanic({ ...p })).toBe(false)
    expect(JSON.stringify(p)).toBe(JSON.stringify({ name: "Panic" }))
  })

  it("is structural on the brand, not on the name: lookalikes are not Panics", () => {
    expect(isPanic({ name: "Panic", message: "x" })).toBe(false)
    expect(isPanic(Object.assign(new Error("x"), { name: "Panic" }))).toBe(false)
    expect(isPanic(structuredClone(new Panic("x")))).toBe(false)
  })

  it("is total: primitives, null and a revoked Proxy are not Panics (never throws)", () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    for (const u of [undefined, null, 0, "Panic", Symbol("Panic"), proxy]) expect(isPanic(u)).toBe(false)
  })
})
