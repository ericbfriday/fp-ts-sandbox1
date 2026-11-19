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
import { notShipped, repository, shippedTooling, stripSource } from "../src/publish-gate.ts"
import { excluded as sourceSmokeExcluded } from "../src/source-smoke.ts"

const root = join(import.meta.dirname, "..", "..", "..")

interface Manifest {
  readonly name: string
  readonly exports?: Record<string, string | Record<string, string>>
  readonly scripts?: Record<string, string>
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly private?: boolean
  readonly repository?: unknown
  readonly publishConfig?: { readonly exports?: unknown }
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

describe("source-condition smoke (ADR-0002 gate, #63)", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
  const rootScripts = (readJson("package.json") as Manifest).scripts ?? {}
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  const names = packages.map((p) => p.manifest.name)

  it("pnpm run ci and the CI workflow run the source smoke after the dist smokes", () => {
    expect(rootScripts["smoke:source"]).toBe("node tooling/gates/src/source-smoke.ts")
    const ci = rootScripts["ci"]?.split(" && ") ?? []
    expect(ci.indexOf("pnpm run smoke:source")).toBe(ci.indexOf("pnpm run smoke") + 1)
    expect(workflow).toMatch(/- run: pnpm run smoke\n\s+(#.*\n\s+)*- run: pnpm run smoke:source\n/)
  })

  it.each(Object.entries(sourceSmokeExcluded))("excluded %s is a package, with a reason", (name, reason) => {
    expect(names).toContain(name)
    expect(reason.length).toBeGreaterThan(20)
  })

  // The smoke reaches an entry only through its `@friday-friday/source` target, so every built
  // entry of every smoked package needs one, and it must name a file that exists.
  it.each(packages.filter((p) => !(p.manifest.name in sourceSmokeExcluded)).map((p) => [p.manifest.name, p] as const))(
    "every built export of %s has a source target",
    (_name, p) => {
      for (const [subpath, entry] of Object.entries(p.manifest.exports ?? {})) {
        if (distTargets(entry).length === 0) continue
        const source = typeof entry === "string" ? undefined : entry["@friday-friday/source"]
        expect(source, subpath).toMatch(/^\.\/src\/.+\.ts$/)
        expect(existsSync(join(root, p.dir, source ?? "")), subpath).toBe(true)
      }
    }
  )

  // Node's type stripping loads `./x.ts` but not `./x.js` when only x.ts exists, and it does not
  // read tsconfig, so a relative specifier names the file on disk (rewriteRelativeImportExtensions
  // and tsdown turn it back into `.js` in dist). Tests follow the same rule as src.
  const dirs = ["packages", "tooling"].flatMap((g) =>
    readdirSync(join(root, g)).flatMap((w) => ["src", "test"].map((s) => `${g}/${w}/${s}`))
  ).filter((d) => existsSync(join(root, d)))
  const sources = dirs.flatMap((d) =>
    readdirSync(join(root, d), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => `${d}/${f}`)
  )

  it.each(sources.map((f) => [f] as const))("%s has no relative `.js` specifier for a `.ts` file", (file) => {
    const text = readFileSync(join(root, file), "utf8")
    const stale = [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)\.js["']/g)]
      .map((m) => m[1] ?? "")
      .filter((spec) => [".ts", ".tsx"].some((ext) => existsSync(join(root, file, "..", spec + ext))))
    expect(stale).toEqual([])
  })
})

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
      "pnpm run smoke:source",
      "pnpm run pack:check",
      "pnpm run build:examples"
    ])
    expect(workflow).toContain("- run: pnpm run build:examples")
  })
})

describe("suite packages are peers (ADR-0006, #62)", () => {
  // One copy of core (and schema) per app: every package that imports another suite package
  // lists it under peerDependencies (`workspace:^`, rewritten to a real range on pack) and under
  // devDependencies (`workspace:*`, for the workspace link), never under dependencies.
  const imported = (p: Workspace): ReadonlyArray<string> => {
    const src = join(root, p.dir, "src")
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))
    const names = files.flatMap((f) =>
      [...readFileSync(join(src, f), "utf8").matchAll(/from "(@friday-friday\/[\w-]+)/g)].map((m) => m[1] ?? "")
    )
    return [...new Set(names)].filter((n) => n !== p.manifest.name).toSorted()
  }
  const suite = (deps: Record<string, string> | undefined): ReadonlyArray<string> =>
    Object.keys(deps ?? {}).filter((d) => d.startsWith("@friday-friday/")).toSorted()

  it.each(packages.map((p) => [p.manifest.name, p] as const))(
    "%s lists no suite package under dependencies",
    (_n, p) => {
      expect(suite(p.manifest.dependencies)).toEqual([])
    }
  )

  it.each(packages.map((p) => [p.manifest.name, p] as const))(
    "%s peers exactly the suite packages it imports",
    (_n, p) => {
      expect(suite(p.manifest.peerDependencies)).toEqual(imported(p))
      for (const name of imported(p)) {
        expect(p.manifest.peerDependencies?.[name], name).toBe("workspace:^")
        expect(p.manifest.devDependencies?.[name], name).toBe("workspace:*")
      }
    }
  )
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

describe("publish gate (#65, #51 story 22)", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
  const rootManifest = readJson("package.json") as Manifest
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  const tooling = readdirSync(join(root, "tooling"), { withFileTypes: true }).filter((d) => d.isDirectory())

  it("pnpm run ci and a CI job pack every package after building it", () => {
    expect(rootManifest.scripts?.["pack:check"]).toBe("node tooling/gates/src/publish-gate.ts")
    const ci = rootManifest.scripts?.["ci"]?.split(" && ") ?? []
    expect(ci.indexOf("pnpm run pack:check")).toBeGreaterThan(ci.indexOf("pnpm run size"))
    const job = workflow.slice(workflow.indexOf("\n  publish-check:"))
    expect(job).toMatch(/- run: pnpm run build\n\s+(#.*\n\s+)*- run: pnpm run pack:check\n/)
  })

  // CI must not fetch the gate's tools at run time (offline-safe after a frozen install).
  it.each(["publint", "@arethetypeswrong/cli"])("root devDependencies pin %s exactly", (tool) => {
    expect(rootManifest.devDependencies?.[tool]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // pnpm 12 swaps `publishConfig.exports` in on pack, so the workspace keeps the source condition
  // (vitest, tsconfig customConditions, smoke:source) and the tarball never names `src`.
  const shipped = workspaces("tooling").filter((w) => shippedTooling.includes(w.dir))

  it.each([...packages, ...shipped].map((p) => [p.manifest.name, p] as const))(
    "%s publishConfig.exports is its exports without the source condition",
    (_name, p) => {
      expect(p.manifest.publishConfig?.exports).toEqual(stripSource(p.manifest.exports ?? {}))
    }
  )

  it.each([...packages, ...workspaces("tooling")].map((w) => [w.dir, w] as const))(
    "%s has repository with its directory (npm provenance, IDEA §8)",
    (dir, w) => {
      expect(w.manifest.repository).toEqual(repository(dir))
    }
  )

  it.each(
    tooling.filter((d) => !shippedTooling.includes(`tooling/${d.name}`)).map((d) => [`tooling/${d.name}`] as const)
  )(
    "%s is not shipped: listed in notShipped, and private if it has a package.json",
    (dir) => {
      expect(notShipped[dir]?.length ?? 0).toBeGreaterThan(20)
      const path = join(root, dir, "package.json")
      // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
      if (existsSync(path)) expect((readJson(`${dir}/package.json`) as Manifest).private).toBe(true)
    }
  )

  // #44 decision 8: the eslint-plugin ships, the codemod stays internal.
  const note = "docs/decisions/2026-11-19-tooling-not-shipped.md"

  it("the codemod points at the shipping decision", () => {
    expect(existsSync(join(root, note))).toBe(true)
    expect(notShipped["tooling/codemods"]).toContain(note)
  })

  it("the shipping decision is recorded as decided", () => {
    expect(readFileSync(join(root, note), "utf8")).toMatch(/\*\*Status: decided/)
  })

  it.each(shippedTooling.map((dir) => [dir] as const))(
    "shipped %s is gated like a package: public, dist-only, built and smoked by the root scripts",
    (dir) => {
      expect(notShipped[dir]).toBeUndefined()
      // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
      const m = readJson(`${dir}/package.json`) as Manifest & { readonly files?: ReadonlyArray<string> }
      expect(m.private).toBeUndefined()
      expect(m.files).toEqual(["dist"])
      expect(m.scripts?.["build"]).toBe("tsdown")
      expect(m.scripts?.["smoke"]).toBe("node test/smoke.mjs")
      expect(existsSync(join(root, dir, "test", "smoke.mjs"))).toBe(true)
      for (const script of ["build", "smoke"]) {
        expect(rootManifest.scripts?.[script]).toContain(`--filter "./${dir}"`)
      }
    }
  )
})

describe("peer floors (IDEA §4 'lower bound = oldest in the CI matrix', #109)", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  // The `peer-floor` job's matrix rows: `- pkg: <dir>` followed by `floor: <specs>`.
  const rows = new Map(
    [...workflow.matchAll(/^ {10}- pkg: ([\w-]+)\n {12}floor: "?([^"\n]+)"?$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""])
  )
  /** `<name>@<version>` specs of a row, keyed by name (scoped names keep their leading `@`). */
  const specs = (floor: string): ReadonlyMap<string, string> =>
    new Map(floor.split(/\s+/).map((s) => [s.slice(0, s.lastIndexOf("@")), s.slice(s.lastIndexOf("@") + 1)]))
  /** `4.10` → `4.10.0`: a version or range bound padded to major.minor.patch. */
  const full = (v: string): string => [...v.split("."), "0", "0"].slice(0, 3).join(".")
  const framework = packages.flatMap((p) =>
    Object.entries(p.manifest.peerDependencies ?? {})
      .filter(([peer]) => !peer.startsWith("@friday-friday/"))
      .map(([peer, range]) => [`${p.manifest.name} → ${peer}`, p.dir.slice("packages/".length), peer, range] as const)
  )

  it("the CI workflow runs the peer-floor matrix: install, swap, check, the package's tests", () => {
    expect(workflow).toContain("run: pnpm add -D --filter \"@friday-friday/${{ matrix.pkg }}\" ${{ matrix.floor }}")
    expect(workflow).toContain("run: pnpm exec vitest run \"packages/${{ matrix.pkg }}\"")
    expect(rows.size).toBeGreaterThan(0)
  })

  it.each(framework)("%s has a floor row whose version is the range's lower bound", (_label, dir, peer, range) => {
    // One lower bound per range: `^4.10`, `>=16.3 <18`; an `||` union would hide an untested arm.
    expect(range).not.toContain("||")
    const lower = /^(?:\^|~|>=)?(\d+(?:\.\d+){0,2})/.exec(range)?.[1]
    expect(lower, `unparseable range ${range}`).toBeDefined()
    const floor = rows.get(dir)
    expect(floor, `no peer-floor row for packages/${dir}`).toBeDefined()
    expect(specs(floor ?? "").get(peer)).toBe(full(lower ?? ""))
  })

  it.each([...rows.keys()].map((dir) => [dir] as const))("floor row %s names a package with framework peers", (dir) => {
    expect(framework.some(([, d]) => d === dir)).toBe(true)
  })
})
