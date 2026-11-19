/**
 * Source-condition smoke (ADR-0002 gate, #44 decision 1, #63).
 *
 *   node tooling/gates/src/source-smoke.ts        (pnpm run smoke:source; needs `pnpm run build`)
 *
 * For every `packages/*` export entry with an `@friday-friday/source` target, a child plain Node 24
 * (type stripping, no loader, no tsconfig `paths`) runs
 * `import("<name><subpath>")` with `--conditions=@friday-friday/source`, from the package's own
 * directory (package self-reference). So the whole graph under that entry, suite peers included,
 * loads from `src/*.ts`. Where the entry also has a built `default` target, the source module must
 * export exactly the names the dist module exports. Exits 1 on any failure.
 *
 * Packages listed in `excluded` are skipped, each with its reason; tooling/gates checks the list.
 */
/* oxlint-disable no-console -- CLI tool: stdout/stderr are the interface */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** Packages the source smoke skips, with the reason. Every other package is smoked. */
export const excluded: Readonly<Record<string, string>> = {
  "@friday-friday/next":
    "next@16.4 ships no `exports` map, so plain Node ESM cannot resolve the `next/navigation` and `next/error` subpaths its src imports at load time; test/smoke.mjs covers its dist with those two stubbed"
}

const condition = "@friday-friday/source"

type Target = string | { readonly [condition: string]: Target }

interface Manifest {
  readonly name: string
  readonly exports?: Readonly<Record<string, Target>>
}

interface Entry {
  readonly dir: string
  readonly specifier: string
  readonly dist: string | undefined
}

const keys = (module: object): ReadonlyArray<string> => Object.keys(module).toSorted()

const entries = (root: string): ReadonlyArray<Entry> =>
  readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, "packages", d.name, "package.json")))
    .flatMap((d) => {
      const dir = join(root, "packages", d.name)
      // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest
      if (manifest.name in excluded) return []
      return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
        if (typeof target === "string" || typeof target[condition] !== "string") return []
        const dist = target["default"]
        return [{
          dir,
          specifier: manifest.name + subpath.slice(1),
          dist: typeof dist === "string" && dist.startsWith("./dist/") ? join(dir, dist) : undefined
        }]
      })
    })

const loadSource = (entry: Entry): { readonly keys: ReadonlyArray<string> } | { readonly error: string } => {
  const child = spawnSync(
    process.execPath,
    [
      `--conditions=${condition}`,
      "--input-type=module",
      "-e",
      "const m = await import(process.argv[1]); console.log(JSON.stringify(Object.keys(m).toSorted()))",
      entry.specifier
    ],
    { cwd: entry.dir, encoding: "utf8" }
  )
  if (child.status !== 0) return { error: child.stderr.trim() }
  // oxlint-disable-next-line no-unsafe-type-assertion -- the child prints a JSON string array
  return { keys: JSON.parse(child.stdout) as ReadonlyArray<string> }
}

const main = async (): Promise<void> => {
  const root = join(import.meta.dirname, "..", "..", "..")
  const failures: Array<string> = []
  for (const entry of entries(root)) {
    const source = loadSource(entry)
    if ("error" in source) {
      failures.push(`${entry.specifier}: does not load from src\n${source.error}`)
      continue
    }
    if (entry.dist !== undefined) {
      if (!existsSync(entry.dist)) {
        failures.push(`${entry.specifier}: ${entry.dist} is missing (run \`pnpm run build\` first)`)
        continue
      }
      // oxlint-disable-next-line no-unsafe-type-assertion -- a module namespace is an object
      const dist = keys((await import(pathToFileURL(entry.dist).href)) as object)
      if (JSON.stringify(dist) !== JSON.stringify(source.keys)) {
        failures.push(
          `${entry.specifier}: src exports [${source.keys.join(", ")}] but dist exports [${dist.join(", ")}]`
        )
        continue
      }
    }
    console.log(`ok   ${entry.specifier} (${source.keys.length} exports)`)
  }
  for (const [name, reason] of Object.entries(excluded)) console.log(`skip ${name}: ${reason}`)
  if (failures.length > 0) {
    console.error(`\n${failures.join("\n\n")}`)
    process.exit(1)
  }
}

if (import.meta.main) await main()
