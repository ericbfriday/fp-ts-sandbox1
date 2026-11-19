/**
 * Type-instantiation budget check (IDEA §8, ADR-0004, #61).
 *
 *   node tooling/type-budget/src/check.ts [--budget <path>]
 *
 * Runs the installed `typescript` (whatever the CI matrix swapped in) with `--extendedDiagnostics`
 * on fixture/core-stress.ts and fixture/core-baseline.ts. The difference is the cost of the stress
 * call sites alone. Exits 1 when that passes the ceiling recorded for this TypeScript major.minor,
 * when no ceiling is recorded for it, or when either fixture has a type error.
 */
/* oxlint-disable no-console -- CLI tool: stdout/stderr are the interface */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { parseArgs } from "node:util"

interface Entry {
  readonly tsc: string
  readonly measured: number
  readonly ceiling: number
}

interface Budget {
  readonly versions: Readonly<Record<string, Entry>>
}

const here = join(import.meta.dirname, "..")
const root = join(here, "..", "..")
const { values } = parseArgs({ options: { budget: { type: "string" } } })
const budgetPath = values.budget ?? join(here, "budget.json")

const fail = (lines: ReadonlyArray<string>): never => {
  console.error(lines.join("\n"))
  process.exit(1)
}

const tscBin = ((): string => {
  const pkgPath = createRequire(join(root, "package.json")).resolve("typescript/package.json")
  // oxlint-disable-next-line no-unsafe-type-assertion -- typescript's package.json declares `bin.tsc`
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: { tsc: string } }
  return join(dirname(pkgPath), pkg.bin.tsc)
})()

const tsc = (args: ReadonlyArray<string>): string => {
  const run = spawnSync(process.execPath, [tscBin, ...args], { cwd: root, encoding: "utf8" })
  if (run.status !== 0) {
    fail([`type-budget: \`tsc ${args.join(" ")}\` failed (exit ${run.status})`, run.stdout, run.stderr])
  }
  return run.stdout
}

const instantiations = (tsconfig: string): number => {
  const project = relative(root, join(here, "fixture", tsconfig))
  const out = tsc(["-p", project, "--extendedDiagnostics"])
  const match = /^Instantiations:\s+([\d,]+)\s*$/m.exec(out)
  if (match?.[1] === undefined) {
    return fail([`type-budget: no "Instantiations:" line in tsc output for ${project}`, out])
  }
  return Number(match[1].replaceAll(",", ""))
}

const version = /Version (\S+)/.exec(tsc(["--version"]))?.[1] ?? "unknown"
const key = /^\d+\.\d+/.exec(version)?.[0] ?? version
// oxlint-disable-next-line no-unsafe-type-assertion -- budget.json is this tool's own file
const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as Budget
const entry = budget.versions[key]
const budgetFile = relative(root, budgetPath)

if (entry === undefined) {
  fail([
    `type-budget: no ceiling recorded for TypeScript ${key} (running ${version}) in ${budgetFile}.`,
    `Measure it with this script's output on ${version} and add a "${key}" entry: measured, and ceiling = measured + 20%.`
  ])
} else {
  const stress = instantiations("tsconfig.json")
  const baseline = instantiations("tsconfig.baseline.json")
  const cost = stress - baseline
  const change = `${cost >= entry.measured ? "+" : ""}${(((cost - entry.measured) / entry.measured) * 100).toFixed(1)}%`
  const summary = `${cost} instantiations (stress ${stress} - baseline ${baseline}), ${change} vs ${entry.measured}`
    + ` recorded on ${entry.tsc}; ceiling ${entry.ceiling}`
  if (cost > entry.ceiling) {
    fail([
      `type-budget: FAIL on TypeScript ${version}: ${summary}.`,
      `The fixture's call sites in tooling/type-budget/fixture/core-stress.ts now cost more than the ceiling in ${budgetFile}.`,
      "Find the signature that regressed (tsc -p tooling/type-budget/fixture/tsconfig.json --generateTrace <dir>).",
      "If the extra cost is intended, re-measure and update `measured` and `ceiling` with a justification in the PR body (ADR-0004)."
    ])
  }
  console.log(`type-budget: ok on TypeScript ${version}: ${summary}.`)
}
