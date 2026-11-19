/**
 * Type-instantiation budget CLI (#61), driven through its interface: the exit code and message of
 * `node src/check.ts --budget <file>` against the fixture, on whatever TypeScript is installed.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const here = join(import.meta.dirname, "..")
const installed = /^\d+\.\d+/.exec(
  // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
  (JSON.parse(readFileSync(join(here, "..", "..", "node_modules", "typescript", "package.json"), "utf8")) as {
    version: string
  }).version
)?.[0] ?? ""

const run = (versions: Record<string, { tsc: string; measured: number; ceiling: number }>) => {
  const file = join(mkdtempSync(join(tmpdir(), "type-budget-")), "budget.json")
  writeFileSync(file, JSON.stringify({ versions }))
  const r = spawnSync(process.execPath, [join(here, "src", "check.ts"), "--budget", file], { encoding: "utf8" })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe("type-budget check", () => {
  it("passes under the ceiling recorded for the installed TypeScript", () => {
    const r = run({ [installed]: { tsc: "test", measured: 1, ceiling: 1_000_000 } })
    expect(r.stderr).toBe("")
    expect(r.stdout).toMatch(/^type-budget: ok on TypeScript \S+: \d+ instantiations/)
    expect(r.status).toBe(0)
  })

  it("fails with the cost, the ceiling and the fixture when the ceiling is exceeded", () => {
    const r = run({ [installed]: { tsc: "test", measured: 10, ceiling: 12 } })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/^type-budget: FAIL on TypeScript \S+: \d+ instantiations .*; ceiling 12\./)
    expect(r.stderr).toContain("tooling/type-budget/fixture/core-stress.ts")
  })

  it("fails when no ceiling is recorded for the installed TypeScript", () => {
    const r = run({ "0.0": { tsc: "0.0.0", measured: 1, ceiling: 1 } })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`no ceiling recorded for TypeScript ${installed}`)
  })
})
