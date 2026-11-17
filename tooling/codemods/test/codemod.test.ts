/**
 * Codemod behavior tests: run the transform over fixture files and assert the output.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CODEMOD = join(import.meta.dirname, "../neverthrow-to-core.mjs")

const run = (fixture: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "codemod-"))
  const file = join(dir, "input.ts")
  writeFileSync(file, fixture)
  execFileSync(process.execPath, [CODEMOD, "--write", file], { stdio: "pipe" })
  const out = readFileSync(file, "utf8")
  rmSync(dir, { recursive: true, force: true })
  return out
}

describe("neverthrow-to-core", () => {
  it("rewrites the import specifier and 1:1 identifiers", () => {
    const out = run(`import { err, ok, ResultAsync } from "neverthrow"\nexport const r = ok(1)\n`)
    expect(out).toContain("from \"@friday-friday/core\"")
    expect(out).not.toContain("neverthrow")
    expect(out).toContain("AsyncResult")
  })

  it("leaves non-mapped APIs untouched but flags them", () => {
    const fixture = `import { Result, ok } from "neverthrow"\nexport const c = Result.combine([ok(1)])\n`
    const dir = mkdtempSync(join(tmpdir(), "codemod-"))
    const file = join(dir, "input.ts")
    writeFileSync(file, fixture)
    const stdout = execFileSync(process.execPath, [CODEMOD, "--write", file], { encoding: "utf8" })
    const out = readFileSync(file, "utf8")
    rmSync(dir, { recursive: true, force: true })
    expect(out).toContain("Result.combine") // untouched, flagged
    expect(stdout).toContain("REVIEW")
    expect(stdout).toContain("Result.combine")
  })

  it("never invents mappings for unknown imports", () => {
    const out = run(`import { somethingElse } from "neverthrow"\nexport const x = somethingElse\n`)
    expect(out).toContain("from \"@friday-friday/core\"")
    expect(out).toContain("somethingElse")
  })
})
