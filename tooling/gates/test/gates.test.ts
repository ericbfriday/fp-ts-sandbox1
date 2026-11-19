/**
 * Gate coverage (issue #43): the repo's gates cover what their docs claim.
 *
 * Seam: the workspace manifests the gates are driven by (package.json `exports`
 * and `scripts`, `.size-limit.json`, the root `check` script, AGENTS.md). Each
 * test fails when a package or subpath is added without wiring it into the gate
 * that the docs say covers it, so the claim can't drift silently again.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..", "..")

interface Manifest {
  readonly name: string
  readonly exports?: Record<string, string | Record<string, string>>
  readonly scripts?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}

interface Workspace {
  readonly dir: string
  readonly manifest: Manifest
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"))

const workspaces = (group: "packages" | "tooling" | "examples"): ReadonlyArray<Workspace> =>
  readdirSync(join(root, group), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, group, d.name, "package.json")))
    .map((d) => {
      const dir = `${group}/${d.name}`
      // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
      return { dir, manifest: readJson(`${dir}/package.json`) as Manifest }
    })

/** Built JS files an export entry resolves to at runtime (types and source conditions excluded). */
const distTargets = (entry: string | Record<string, string>): ReadonlyArray<string> =>
  (typeof entry === "string" ? [entry] : Object.values(entry)).filter((t) =>
    t.startsWith("./dist/") && t.endsWith(".js")
  )

const packages = workspaces("packages")

describe("dist smokes (ADR-0002 gate)", () => {
  // next@16.4 ships no `exports` map, so next's smoke stubs `next/*` and imports its dist
  // dynamically (the root's default entry throws by design; react-server runs in a child, #53).
  it.each(packages.map((p) => [p.manifest.name, p] as const))("%s has a smoke script", (_name, p) => {
    expect(p.manifest.scripts?.["smoke"]).toBe("node test/smoke.mjs")
    expect(existsSync(join(root, p.dir, "test", "smoke.mjs"))).toBe(true)
  })

  it.each(packages.map((p) => [p.manifest.name, p] as const))("%s smoke imports every export entry", (_name, p) => {
    const smoke = readFileSync(join(root, p.dir, "test", "smoke.mjs"), "utf8")
    const targets = Object.values(p.manifest.exports ?? {}).flatMap(distTargets)
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      const path = `"../${target.slice(2)}"`
      expect(smoke.includes(`from ${path}`) || smoke.includes(`import(${path})`), target).toBe(true)
    }
  })
})

interface SizeEntry {
  readonly name: string
  readonly path: string
  readonly ignore?: ReadonlyArray<string>
}

describe("size budgets (ADR-0004 gate)", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- .size-limit.json is size-limit's documented array shape
  const entries = readJson(".size-limit.json") as ReadonlyArray<SizeEntry>
  const outputs = packages.flatMap((p) =>
    Object.values(p.manifest.exports ?? {}).flatMap(distTargets).map((t) => [`${p.dir}/${t.slice(2)}`, p] as const)
  )

  it.each(outputs)("%s has a size-limit entry", (path) => {
    expect(entries.map((e) => e.path)).toContain(path)
  })

  // DEVELOPER.md: budgets exclude peers ("≤ 2 kB excluding peers"), so every runtime peer is ignored.
  it.each(outputs)("%s budget excludes the package's peers", (path, p) => {
    const peers = Object.keys(p.manifest.peerDependencies ?? {})
    for (const entry of entries.filter((e) => e.path === path)) {
      expect(entry.ignore ?? []).toEqual(expect.arrayContaining(peers))
    }
  })
})

describe("typecheck (ADR-0004 gate)", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
  const rootManifest = readJson("package.json") as Manifest
  const check = rootManifest.scripts?.["check"] ?? ""
  const examples = workspaces("examples").filter((e) => existsSync(join(root, e.dir, "tsconfig.json")))

  // The root tsconfig only globs examples/*/src; an example's own tsconfig (DOM lib, `@/*`
  // paths, test/) is what the app compiles under, so `check` runs each one. CI's typecheck
  // matrix runs `pnpm run check`, so this also covers TS 6.0 / 7.0 / 7.1.
  it.each(examples.map((e) => [e.dir] as const))("pnpm run check typechecks %s with its own tsconfig", (dir) => {
    expect(check).toContain(`tsc -p ${dir}/tsconfig.json`)
  })

  // IDEA §8 / ADR-0004 (#61): the type-instantiation budget runs wherever `check` runs, so on
  // every TypeScript in the matrix, and each of those versions has a recorded ceiling.
  it("pnpm run check runs the type-instantiation budget", () => {
    expect(check.split(" && ")).toContain("node tooling/type-budget/src/check.ts")
  })

  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  const matrix = [...workflow.matchAll(/\{ name: "(\d+\.\d+)[^"]*", spec: /g)].map((m) => m[1] ?? "")
  // oxlint-disable-next-line no-unsafe-type-assertion -- budget.json is the check script's own file
  const budget = readJson("tooling/type-budget/budget.json") as {
    readonly versions: Record<string, { readonly measured: number; readonly ceiling: number }>
  }

  it("the CI typecheck matrix lists TypeScript versions", () => {
    expect(matrix.length).toBeGreaterThanOrEqual(3)
  })

  it.each(matrix.map((v) => [v] as const))("TypeScript %s has a recorded instantiation ceiling", (v) => {
    expect(Object.keys(budget.versions)).toContain(v)
  })

  it.each(Object.entries(budget.versions))("TypeScript %s ceiling is within measured × 1.2", (_v, e) => {
    expect(e.ceiling).toBeGreaterThanOrEqual(e.measured)
    expect(e.ceiling).toBeLessThanOrEqual(Math.floor(e.measured * 1.2))
  })

  it.each(examples.map((e) => [e.dir] as const))("%s tsconfig includes its tests", (dir) => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- tsconfig.json shape
    const tsconfig = readJson(`${dir}/tsconfig.json`) as { include?: ReadonlyArray<string> }
    expect(tsconfig.include).toContain("test")
  })
})

describe("example build (Phase 1 exit: the example app builds under Next)", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
  const rootScripts = (readJson("package.json") as Manifest).scripts ?? {}
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")

  it.each(workspaces("examples").map((e) => [e.manifest.name, e] as const))("%s has a build script", (_name, e) => {
    expect(e.manifest.scripts?.["build"]).toBe("next build")
  })

  it("pnpm run ci and the CI workflow both build the examples after the packages", () => {
    expect(rootScripts["build:examples"]).toBe(`pnpm -r --filter "./examples/*" run build`)
    expect(rootScripts["ci"]?.split(" && ")).toEqual([
      "pnpm run lint",
      "pnpm run check",
      "pnpm run test",
      "pnpm run size",
      "pnpm run smoke",
      "pnpm run build:examples"
    ])
    expect(workflow).toContain("- run: pnpm run build:examples")
  })
})

describe("AGENTS.md package map", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8")
  const map = agents.slice(
    agents.indexOf("## Package map"),
    agents.indexOf("\n## ", agents.indexOf("## Package map") + 1)
  )
  const all = [...packages, ...workspaces("tooling"), ...workspaces("examples")]

  it.each(all.map((w) => [w.dir, w] as const))("lists %s with its package name", (dir, w) => {
    expect(map).toContain(`\`${dir}\` — \`${w.manifest.name}\``)
  })

  it.each(packages.map((p) => [p.manifest.name, p] as const))("lists every public subpath of %s", (_name, p) => {
    const subpaths = Object.keys(p.manifest.exports ?? {}).filter(
      (k) =>
        k !== "." && k !== "./package.json" &&
        Object.values(p.manifest.exports?.[k] ?? {}).some((t) => t.startsWith("./dist/"))
    )
    const line = map.split("\n").find((l) => l.includes(`\`${p.dir}\``)) ?? ""
    for (const subpath of subpaths) expect(line).toContain(`\`${subpath.slice(1)}\``)
  })
})
