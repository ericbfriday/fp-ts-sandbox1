/**
 * neverthrow → `@friday-friday/core` import/API codemod (Phase 5, starter).
 *
 * Scope (v1, intentionally mechanical):
 * - rewrites `from "neverthrow"` imports to `from "@friday-friday/core"`
 * - maps identifiers 1:1 where the semantics match:
 *     ResultAsync → AsyncResult, okAsync → ok (async ok), errUnsafeDueToTS2790? (dropped)
 * - leaves everything else untouched; a comment marks lines that need manual review when
 *   an identifier has no 1:1 mapping (andThen is 1:1; `safeTry`/`safeParse` are NOT —
 *   use `/gen` instead, see DEVELOPER.md).
 *
 * Usage: `node tooling/codemods/neverthrow-to-core.mjs <files...>` (or a glob expanded by
 * your shell). Add `--write` to modify in place; default prints a diff-ish preview.
 *
 * NOT migrated (documented, not hidden): Result.combine → all() (argument order differs),
 * safeTry/gen → core/gen, match variants — those are API-shape changes, not renames.
 */
/* oxlint-disable no-console -- CLI tool: stdout/stderr are the interface */
import { readFileSync, writeFileSync } from "node:fs"

const IDENTIFIER_MAP = new Map([
  ["ResultAsync", "AsyncResult"],
  ["okAsync", "ok"],
  ["errAsync", "err"]
])

const args = process.argv.slice(2)
const write = args.includes("--write")
const files = args.filter((a) => !a.startsWith("--"))

if (files.length === 0) {
  console.error("usage: node tooling/codemods/neverthrow-to-core.mjs [--write] <files...>")
  process.exit(1)
}

let changed = 0
for (const file of files) {
  const src = readFileSync(file, "utf8")
  let out = src
  const notes = []

  // 1) import specifier
  out = out.replaceAll('"neverthrow"', '"@friday-friday/core"').replaceAll("'neverthrow'", "'@friday-friday/core'")

  // 2) named identifiers with 1:1 mappings
  for (const [from, to] of IDENTIFIER_MAP) {
    out = out.replaceAll(new RegExp(`\\b${from}\\b`, "g"), to)
  }

  // 3) flag APIs that need manual migration
  for (const api of ["safeTry", "safeParse", "Result.combine", ".combine(", "andThenAsync"]) {
    if (out.includes(api)) {
      notes.push(`${api} needs manual migration (see DEVELOPER.md: ${api === "safeTry" ? "use /gen" : "core has 1:1 or async variants"})`)
    }
  }

  if (out !== src) {
    changed++
    if (write) {
      writeFileSync(file, out)
      console.log(`rewrote ${file}`)
    } else {
      console.log(`would rewrite ${file}`)
    }
  }
  for (const n of notes) console.log(`  REVIEW ${file}: ${n}`)
}

console.log(`${changed} file(s) ${write ? "rewritten" : "would be rewritten"}; review flagged lines.`)
