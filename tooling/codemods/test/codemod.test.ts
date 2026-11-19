/**
 * neverthrow import rewriter (#107, #44 decision 3): exact-output tests over fixtures, plus a real
 * `tsc` run proving an imports-only migration typechecks against `@friday-friday/core`.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const ROOT = resolve(import.meta.dirname, "../../..")
const CODEMOD = join(ROOT, "tooling/codemods/neverthrow-imports.mjs")
const dirs: Array<string> = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "codemod-"))
  dirs.push(dir)
  return dir
}

/** Runs the CLI with --write on one fixture; returns the rewritten text and stdout. */
const run = (fixture: string): { out: string; stdout: string; file: string } => {
  const file = join(tempDir(), "input.ts")
  writeFileSync(file, fixture)
  const stdout = execFileSync(process.execPath, [CODEMOD, "--write", file], { encoding: "utf8" })
  return { out: readFileSync(file, "utf8"), stdout, file }
}

const lines = (...l: Array<string>): string => l.join("\n")

describe("neverthrow-imports: realistic file", () => {
  const input = lines(
    `import { err, ok, okAsync, ResultAsync, type Result, fromThrowable } from "neverthrow"`,
    ``,
    `type User = { id: string; name: string }`,
    ``,
    `export const parse = fromThrowable(JSON.parse, () => "bad json" as const)`,
    ``,
    `export function findUser(id: string): ResultAsync<User, "not-found"> {`,
    `  if (id === "") return ResultAsync.fromPromise(Promise.reject(new Error("x")), () => "not-found" as const)`,
    `  return okAsync({ id, name: "ada" })`,
    `}`,
    ``,
    `export function check(r: Result<number, string>): string {`,
    `  if (r.isOk()) return "ok"`,
    `  return r`,
    `    .map((n) => n + 1)`,
    `    .match(`,
    `      (n) => String(n),`,
    `      (e) => e`,
    `    )`,
    `}`,
    ``,
    `export const base = err("boom")`,
    `export const one = ok(1)`,
    ``
  )

  it("rewrites the imports, keeps what it can't map, and flags every line that needs a human", () => {
    const { out } = run(input)
    expect(out).toBe(lines(
      `import { err, ok, type AsyncResult, type Result } from "@friday-friday/core"`,
      `import { fromThrowable } from "neverthrow"`,
      ``,
      `type User = { id: string; name: string }`,
      ``,
      `// REVIEW(neverthrow): \`fromThrowable\` is still imported from neverthrow`,
      `export const parse = fromThrowable(JSON.parse, () => "bad json" as const)`,
      ``,
      `export function findUser(id: string): AsyncResult<User, "not-found"> {`,
      `  // REVIEW(neverthrow): AsyncResult.fromPromise: → \`tryAsync\` (core/async)`,
      `  if (id === "") return AsyncResult.fromPromise(Promise.reject(new Error("x")), () => "not-found" as const)`,
      `  // REVIEW(neverthrow): okAsync(…) is now core's synchronous \`ok\`; wrap in Promise.resolve(…) where an AsyncResult is expected`,
      `  return ok({ id, name: "ada" })`,
      `}`,
      ``,
      `export function check(r: Result<number, string>): string {`,
      `  // REVIEW(neverthrow): .isOk(): \`r.isOk()\` → \`r.ok\``,
      `  if (r.isOk()) return "ok"`,
      `  return r`,
      `    // REVIEW(neverthrow): .map(): \`r.map(f)\` → \`map(r, f)\` (core); ignore if this is an array`,
      `    .map((n) => n + 1)`,
      `    // REVIEW(neverthrow): .match(): \`r.match(onOk, onErr)\` → \`match(r, { ok: onOk, err: onErr })\``,
      `    .match(`,
      `      (n) => String(n),`,
      `      (e) => e`,
      `    )`,
      `}`,
      ``,
      `export const base = err("boom")`,
      `export const one = ok(1)`,
      ``
    ))
  })

  it("prints each flag as file:line of the flagged code, and the total", () => {
    const { stdout, file } = run(input)
    expect(stdout).toContain(`${file}:7: REVIEW \`fromThrowable\` is still imported from neverthrow`)
    expect(stdout).toContain(`${file}:18: REVIEW .isOk()`)
    expect(stdout).toContain(`${file}:21: REVIEW .map()`)
    expect(stdout).toContain("1 file(s) rewritten; 6 line(s) flagged for REVIEW.")
  })

  it("is idempotent: a second run changes nothing and adds no flags", () => {
    const first = run(input)
    const again = execFileSync(process.execPath, [CODEMOD, "--write", first.file], { encoding: "utf8" })
    expect(readFileSync(first.file, "utf8")).toBe(first.out)
    expect(again).toContain("0 file(s) rewritten; 0 line(s) flagged for REVIEW.")
  })
})

describe("neverthrow-imports: import rewriting", () => {
  it("merges duplicates (ok + okAsync → ok) instead of emitting a duplicate binding", () => {
    const { out } = run(`import { ok, okAsync } from "neverthrow"\nexport const a = ok(1)\n`)
    expect(out).toBe(`import { ok } from "@friday-friday/core"\nexport const a = ok(1)\n`)
  })

  it("keeps `import type` declarations type-only", () => {
    const { out } = run(
      `import type { Result, ResultAsync } from 'neverthrow'\nexport type R = ResultAsync<1, 2> | Result<1, 2>\n`
    )
    expect(out).toBe(
      `import type { Result, AsyncResult } from '@friday-friday/core'\nexport type R = AsyncResult<1, 2> | Result<1, 2>\n`
    )
  })

  it("keeps an alias and flags its call sites (okAsync as oa)", () => {
    const { out } = run(`import { okAsync as oa } from "neverthrow"\nexport const a = oa(1)\n`)
    expect(out).toBe(
      `import { ok as oa } from "@friday-friday/core"\n` +
        `// REVIEW(neverthrow): oa(…) is now synchronous; wrap in Promise.resolve(…) where an AsyncResult is expected\n` +
        `export const a = oa(1)\n`
    )
  })

  it("flags a namespace import it cannot rewrite, and leaves it in place", () => {
    const { out } = run(`import * as nt from "neverthrow"\nexport const a = nt.ok(1)\n`)
    expect(out).toBe(
      `// REVIEW(neverthrow): default/namespace import of neverthrow: migrate by hand\n` +
        `import * as nt from "neverthrow"\nexport const a = nt.ok(1)\n`
    )
  })

  it("leaves files without a neverthrow import untouched (no flags on array .map)", () => {
    const src = `export const xs = [1, 2].map((n) => n + 1)\n`
    const { out, stdout } = run(src)
    expect(out).toBe(src)
    expect(stdout).toContain("0 file(s) rewritten; 0 line(s) flagged for REVIEW.")
  })
})

describe("neverthrow-imports: output typechecks against core", () => {
  it("an imports-only migration typechecks with tsc against @friday-friday/core", () => {
    const { out, stdout } = run(lines(
      `import { err, ok, okAsync, type Ok, type Err, Result, ResultAsync } from "neverthrow"`,
      ``,
      `export const parsePort = (s: string): Result<number, string> => {`,
      `  const n = Number(s)`,
      `  return Number.isInteger(n) ? ok(n) : err("not a port")`,
      `}`,
      `export const later = async (): ResultAsync<number, never> => okAsync(1)`,
      `export type Branch = Ok<number> | Err<string>`,
      ``
    ))
    expect(stdout).toContain("1 line(s) flagged for REVIEW.") // the okAsync call site
    const project = tempDir()
    writeFileSync(join(project, "migrated.ts"), out)
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        extends: join(ROOT, "tsconfig.base.json"),
        compilerOptions: {
          // Core's src uses Node globals (AbortSignal); resolve @types from the repo root.
          typeRoots: [join(ROOT, "node_modules/@types")],
          types: ["node"],
          paths: { "@friday-friday/core": [join(ROOT, "packages/core/src/index.ts")] }
        },
        files: ["migrated.ts"]
      })
    )
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc")
    // tsc's diagnostics land in the assertion message when the migrated file does not typecheck.
    const result = (() => {
      try {
        execFileSync(process.execPath, [tsc, "-p", join(project, "tsconfig.json")], { encoding: "utf8" })
        return "clean"
      } catch (e) {
        return e instanceof Error && "stdout" in e ? String(e.stdout) : String(e)
      }
    })()
    expect(result).toBe("clean")
  })
})
