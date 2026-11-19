/**
 * Publish gate (#65, #51 story 22): `checkPackage` packs a directory with pnpm and checks the
 * tarball, so these tests drive it with throwaway fixture packages and assert on the failures it
 * reports. Each fixture differs from a passing one by exactly one defect.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { checkPackage, stripSource } from "../src/publish-gate.ts"

const scratch = mkdtempSync(join(tmpdir(), "publish-gate-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json }

const good = {
  name: "fixture-pkg",
  version: "0.0.0",
  license: "MIT",
  type: "module",
  repository: { type: "git", url: "git+https://github.com/example/fixture.git", directory: "packages/fixture" },
  exports: {
    ".": { "@friday-friday/source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./test/golden": { "@friday-friday/source": "./test/golden.ts" },
    "./package.json": "./package.json"
  },
  publishConfig: {
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./package.json": "./package.json"
    }
  },
  files: ["dist"],
  peerDependencies: { "peer-dep": "^1" }
} as const

let count = 0
/** Writes a fixture package (manifest + dist) and returns its directory. */
const fixture = (
  manifest: { readonly [key: string]: Json },
  js = `import { x } from "peer-dep"\nexport const a = x\n`
): string => {
  count += 1
  const dir = join(scratch, `fixture-${count}`)
  mkdirSync(join(dir, "dist"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2))
  writeFileSync(join(dir, "dist", "index.js"), js)
  writeFileSync(join(dir, "dist", "index.d.ts"), "export declare const a: number\n")
  return dir
}

describe("stripSource", () => {
  it("drops the source condition and every entry left with no target", () => {
    expect(stripSource(good.exports)).toEqual(good.publishConfig.exports)
  })

  it("keeps string targets and nested conditions in order", () => {
    expect(
      stripSource({
        ".": { "@friday-friday/source": "./src/a.ts", types: "./a.d.ts", "react-server": "./a.js", default: "./b.js" },
        "./x": "./x.js"
      })
    ).toEqual({ ".": { types: "./a.d.ts", "react-server": "./a.js", default: "./b.js" }, "./x": "./x.js" })
  })
})

describe("checkPackage (packs the directory, checks the tarball)", { timeout: 60_000 }, () => {
  it("passes a package whose packed manifest is clean", () => {
    expect(checkPackage(fixture(good))).toEqual([])
  })

  it("fails when the packed manifest keeps the source condition", () => {
    const { publishConfig: _, ...leaky } = good
    const failures = checkPackage(fixture(leaky))
    expect(failures.join("\n")).toMatch(/@friday-friday\/source/)
  })

  it("fails without repository.directory (npm provenance, IDEA §8)", () => {
    const failures = checkPackage(fixture({ ...good, repository: { type: "git", url: good.repository.url } }))
    expect(failures.join("\n")).toMatch(/repository/)
  })

  it("fails when an export target is not in the tarball (publint --strict)", () => {
    const failures = checkPackage(fixture({
      ...good,
      publishConfig: { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/missing.js" } } }
    }))
    expect(failures.join("\n")).toMatch(/publint[\s\S]*missing\.js/)
  })

  it("fails when an entry resolves under no ESM resolution (attw --profile esm-only)", () => {
    const failures = checkPackage(fixture({
      ...good,
      publishConfig: { exports: { ...good.publishConfig.exports, "./custom": { custom: "./dist/index.js" } } }
    }))
    expect(failures.join("\n")).toMatch(/attw[\s\S]*\/custom/)
  })

  it("fails when packed code imports a package it does not declare", () => {
    const failures = checkPackage(fixture(good, `import { x } from "undeclared-dep/sub"\nexport const a = x\n`))
    expect(failures.join("\n")).toMatch(/undeclared-dep/)
  })

  // In the workspace pnpm rewrites `workspace:^` to a real range; one it cannot resolve must fail
  // the gate (pnpm refuses to pack it), never reach a tarball.
  it("fails when a dependency's workspace protocol cannot be rewritten", () => {
    const failures = checkPackage(fixture({ ...good, peerDependencies: { "peer-dep": "workspace:^" } }))
    expect(failures.join("\n")).toMatch(/workspace/)
  })
})
