/**
 * Publish gate (#65, #51 story 22, IDEA §8 "Publishing").
 *
 *   node tooling/gates/src/publish-gate.ts        (pnpm run pack:check; needs `pnpm run build`)
 *
 * For every `packages/*` package, and each `shippedTooling` directory: `pnpm pack` it (pnpm rewrites `workspace:` ranges and swaps in
 * `publishConfig.exports`), then check the tarball, not the workspace:
 * - the packed manifest has no `@friday-friday/source` condition (src is not in the tarball) and
 *   no `workspace:` range, and has `repository` with `directory` (npm provenance);
 * - every bare import in the packed JS and `.d.ts` is a declared dependency or peer;
 * - `publint run --strict` and `attw --profile esm-only` pass on the tarball.
 * Exits 1 on any failure. Nothing is published: this only packs into a temp dir.
 *
 * Stripping: each package keeps the source condition in `exports` (vitest, tsconfig
 * `customConditions` and `pnpm run smoke:source` resolve through it) and declares
 * `publishConfig.exports` = `stripSource(exports)`, which pnpm 12 uses on pack. tooling/gates
 * checks the two stay in step, so a source-only entry (core's `./test/wire-golden`) never ships.
 */
/* oxlint-disable no-console -- CLI tool: stdout/stderr are the interface */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const condition = "@friday-friday/source"
const root = join(import.meta.dirname, "..", "..", "..")

type Target = string | { readonly [condition: string]: Target }
type Exports = Readonly<Record<string, Target>>

/**
 * Workspaces under tooling/ that ship like a `packages/*` package (built to dist, packed and
 * checked here). #44 decision 8: the eslint-plugin ships with the suite's first release.
 */
export const shippedTooling: ReadonlyArray<string> = ["tooling/eslint-plugin"]

/**
 * Workspaces under tooling/ that are never packed or published, with the reason. tooling/gates
 * checks that every tooling directory is listed here or in `shippedTooling`, and that any listed
 * here with a package.json is private.
 */
export const notShipped: Readonly<Record<string, string>> = {
  "tooling/codemods":
    "a plain script with no package.json, so nothing can pack it; it stays internal (#44 decisions 3 and 8), see docs/decisions/2026-11-19-tooling-not-shipped.md",
  "tooling/gates": "repo-internal CI gates (plain dir, no package.json)",
  "tooling/type-budget": "repo-internal type-instantiation budget (plain dir, no package.json)"
}

/** The `repository` every workspace package declares (npm provenance needs `directory`). */
export const repository = (directory: string): {
  readonly type: "git"
  readonly url: string
  readonly directory: string
} => ({ type: "git", url: "git+https://github.com/ericbfriday/fp-ts-sandbox1.git", directory })

const stripTarget = (target: Target): Target | undefined => {
  if (typeof target === "string") return target
  const kept = Object.entries(target).flatMap(([key, value]) => {
    if (key === condition) return []
    const inner = stripTarget(value)
    return inner === undefined ? [] : [[key, inner] as const]
  })
  return kept.length === 0 ? undefined : Object.fromEntries(kept)
}

/** `exports` without the source condition; an entry left with no target (source-only) is dropped. */
export const stripSource = (exports: Exports): Exports =>
  Object.fromEntries(
    Object.entries(exports).flatMap(([subpath, target]) => {
      const kept = stripTarget(target)
      return kept === undefined ? [] : [[subpath, kept] as const]
    })
  )

interface Packed {
  readonly name: string
  readonly repository?: unknown
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

const run = (command: string, args: ReadonlyArray<string>, cwd: string): SpawnSyncReturns<string> =>
  spawnSync(command, args, { cwd, encoding: "utf8" })

const output = (r: SpawnSyncReturns<string>): string => `${r.stdout}${r.stderr}`.trim()

/** Package name of a bare specifier (`@scope/name/sub` -> `@scope/name`), or undefined if not bare. */
const packageOf = (specifier: string): string | undefined => {
  if (/^(\.|\/|node:|data:)/.test(specifier)) return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

const bareImports = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(m?js|d\.m?ts)$/.test(f))
    .flatMap((f) =>
      [...readFileSync(join(dir, f), "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)]
        .map((m) => packageOf(m[1] ?? ""))
        .filter((n) => n !== undefined)
    )

const checkManifest = (manifest: Packed, unpacked: string): ReadonlyArray<string> => {
  const failures: Array<string> = []
  if (JSON.stringify(manifest).includes(condition)) {
    failures.push(`packed package.json still has the ${condition} condition (set publishConfig.exports)`)
  }
  const fields = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const
  for (const field of fields) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) failures.push(`packed ${field}.${dep} is still ${range}`)
    }
  }
  const repo = manifest.repository
  if (
    typeof repo !== "object" || repo === null || !("url" in repo) || typeof repo.url !== "string" ||
    !("directory" in repo) || typeof repo.directory !== "string"
  ) {
    failures.push("packed package.json needs repository { url, directory } (npm provenance)")
  }
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ])
  const undeclared = [...new Set(bareImports(unpacked))].filter((n) => !declared.has(n)).toSorted()
  if (undeclared.length > 0) {
    failures.push(`packed code imports undeclared packages: ${undeclared.join(", ")}`)
  }
  return failures
}

/** Packs `dir` with pnpm and checks the tarball; returns the failures (empty when it passes). */
export const checkPackage = (dir: string): ReadonlyArray<string> => {
  const scratch = mkdtempSync(join(tmpdir(), "publish-gate-"))
  try {
    const pack = run("pnpm", ["pack", "--json", "--pack-destination", scratch], dir)
    if (pack.status !== 0) return [`pnpm pack failed\n${output(pack)}`]
    // oxlint-disable-next-line no-unsafe-type-assertion -- `pnpm pack --json` prints this shape
    const tarball = (JSON.parse(pack.stdout) as { readonly filename: string }).filename
    const untar = run("tar", ["-xzf", tarball, "-C", scratch], scratch)
    if (untar.status !== 0) return [`could not unpack ${tarball}\n${output(untar)}`]
    const unpacked = join(scratch, "package")
    // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
    const manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8")) as Packed
    const failures = [...checkManifest(manifest, unpacked)]
    const bin = (name: string): string => join(root, "node_modules", ".bin", name)
    const publint = run(bin("publint"), ["run", "--strict", tarball], scratch)
    if (publint.status !== 0) failures.push(`publint --strict failed\n${output(publint)}`)
    const attw = run(bin("attw"), [tarball, "--profile", "esm-only"], scratch)
    if (attw.status !== 0) failures.push(`attw --profile esm-only failed\n${output(attw)}`)
    return failures
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const main = (): void => {
  const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, "packages", d.name, "package.json")))
    .map((d) => `packages/${d.name}`)
    .concat(shippedTooling)
  const failures: Array<string> = []
  for (const dir of dirs) {
    const found = checkPackage(join(root, dir))
    if (found.length === 0) console.log(`ok   ${dir}: packed, publint --strict, attw --profile esm-only`)
    else failures.push(`${dir}:\n${found.join("\n\n")}`)
  }
  for (const [dir, reason] of Object.entries(notShipped)) console.log(`skip ${dir}: ${reason}`)
  if (failures.length > 0) {
    console.error(`\n${failures.join("\n\n")}`)
    process.exit(1)
  }
}

if (import.meta.main) main()
