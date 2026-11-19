/**
 * neverthrow → `@friday-friday/core` IMPORT REWRITER (#107, #44 decision 3). Internal tool, not
 * shipped (#44 decision 8).
 *
 * What it does, and all it does:
 * - Rewrites each `import { … } from "neverthrow"` (and `import type`) whose names have a 1:1
 *   core equivalent: `ok`, `err`, `Ok`, `Err`, `Result` (type), `ResultAsync` → `AsyncResult`
 *   (type), `okAsync` → `ok`, `errAsync` → `err`. Duplicate specifiers are merged (`ok, okAsync`
 *   → `ok`), and `Result` / `AsyncResult` / `Ok` / `Err` are imported type-only (core exports
 *   them as types).
 * - Keeps every other name imported from "neverthrow", so nothing it can't map silently
 *   disappears.
 * - Puts a `// REVIEW(neverthrow): …` comment above every line that still needs a human:
 *   neverthrow METHOD calls (`.isOk()`, `.map(`, `.andThen(`, `.match(`, …), static helpers
 *   (`Result.combine`, `ResultAsync.fromPromise`, …), uses of names still imported from
 *   neverthrow, and `okAsync`/`errAsync` call sites (core's `ok`/`err` are synchronous).
 *
 * What it does NOT do: rewrite method chains. neverthrow is method-based (`r.map(f).andThen(g)`);
 * core is function-based (`pipe(r, map(f), andThen(g))` or `andThen(map(r, f), g)`). A file with
 * flagged lines does not typecheck until those lines are migrated by hand — every such line is
 * flagged, none is changed silently. Matching is textual (no types): `.map(` on an array in a
 * neverthrow file is flagged too.
 *
 * Usage: `node tooling/codemods/neverthrow-imports.mjs [--write] <files...>`. Only files that
 * import "neverthrow" are touched. Without `--write` it prints what it would do. Each flag is
 * printed as `file:line: hint`, followed by a total count.
 */
/* oxlint-disable no-console -- CLI tool: stdout/stderr are the interface */
import { readFileSync, writeFileSync } from "node:fs"

/** neverthrow name → core name; `type: true` when core exports it as a type only. */
const MAPPED = new Map([
  ["ok", { to: "ok", type: false }],
  ["err", { to: "err", type: false }],
  ["okAsync", { to: "ok", type: false }],
  ["errAsync", { to: "err", type: false }],
  ["Ok", { to: "Ok", type: true }],
  ["Err", { to: "Err", type: true }],
  ["Result", { to: "Result", type: true }],
  ["ResultAsync", { to: "AsyncResult", type: true }]
])

/** neverthrow instance methods → migration hint (core's combinators take the Result first or
 * are curried for `pipe`). */
const METHOD_HINTS = new Map([
  ["isOk", "`r.isOk()` → `r.ok`"],
  ["isErr", "`r.isErr()` → `!r.ok`"],
  ["map", "`r.map(f)` → `map(r, f)` (core); ignore if this is an array"],
  ["mapErr", "`r.mapErr(f)` → `mapErr(r, f)`"],
  ["andThen", "`r.andThen(f)` → `andThen(r, f)`; async steps → `andThenAsync` (core/async)"],
  ["asyncAndThen", "→ `andThenAsync(r, f)` (core/async)"],
  ["asyncMap", "→ `mapAsync(r, f)` (core/async)"],
  ["orElse", "`r.orElse(f)` → `orElse(r, f)`"],
  ["match", "`r.match(onOk, onErr)` → `match(r, { ok: onOk, err: onErr })`"],
  ["unwrapOr", "`r.unwrapOr(d)` → `unwrapOr(r, d)`"],
  ["andTee", "→ `tap(r, f)`"],
  ["orTee", "→ `tapErr(r, f)`"],
  ["andThrough", "no 1:1 core equivalent; use `andThen` + `map` back to the value"],
  ["asyncAndThrough", "no 1:1 core equivalent; use `andThenAsync` + `map` back to the value"],
  ["_unsafeUnwrap", "no core equivalent; branch on `r.ok` or use `unwrapOr`"],
  ["_unsafeUnwrapErr", "no core equivalent; branch on `r.ok`"],
  ["safeUnwrap", "generator unwrap → core/gen"]
])

/** neverthrow static helpers on `Result` / `ResultAsync` → hint. */
const STATIC_HINTS = new Map([
  ["combine", "→ `all([...])` (core)"],
  ["combineWithAllErrors", "→ `partition([...])` (core) and decide how to report the errors"],
  ["fromThrowable", "→ `trySync(fn, { catch })` (core)"],
  ["fromPromise", "→ `tryAsync` (core/async)"],
  ["fromSafePromise", "→ `promise.then(ok)`"],
  ["fromAsyncThrowable", "→ `tryAsync` (core/async)"]
])

const IMPORT_RE = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+(["'])neverthrow\3;?[ \t]*$/gm
const OTHER_IMPORT_RE = /^import\s+(?:\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+(["'])neverthrow\1/m
const METHOD_RE = new RegExp(`\\.(${[...METHOD_HINTS.keys()].join("|")})\\s*\\(`, "g")
const STATIC_RE = new RegExp(`\\b(?:Result|ResultAsync|AsyncResult)\\.(${[...STATIC_HINTS.keys()].join("|")})\\b`, "g")
const REVIEW = "// REVIEW(neverthrow):"

/**
 * Parses `type? Name (as Local)?` specifiers. Returns `undefined` for anything else (keeps the
 * declaration untouched rather than guessing).
 */
function parseSpecifiers(list) {
  const specs = []
  for (const raw of list.split(",")) {
    const s = raw.trim()
    if (s === "") continue
    const m = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s)
    if (m === null) return undefined
    specs.push({ type: m[1] !== undefined, name: m[2], local: m[3] ?? m[2] })
  }
  return specs
}

const specText = ({ type, name, local }, declType) =>
  `${type && !declType ? "type " : ""}${name}${local === name ? "" : ` as ${local}`}`

/** Rewrites one source text. Returns `{ out, flags: [{ line, hint }] }`; `out === src` when the
 * file has no neverthrow import. */
export function transform(src) {
  const renames = new Map() // local identifier → new local identifier (unaliased renames only)
  const leftovers = [] // local names still imported from neverthrow
  const asyncCtors = [] // local aliases of okAsync/errAsync (`okAsync as oa`)
  let touched = false

  let out = src.replace(IMPORT_RE, (decl, typeKw, list, quote) => {
    const specs = parseSpecifiers(list)
    if (specs === undefined) return decl
    touched = true
    const declType = typeKw !== undefined
    const core = new Map() // dedupe key → spec text
    const kept = []
    for (const spec of specs) {
      const target = MAPPED.get(spec.name)
      if (target === undefined) {
        kept.push(specText(spec, declType))
        leftovers.push(spec.local)
        continue
      }
      const local = spec.local === spec.name ? target.to : spec.local
      if (spec.local === spec.name && spec.name !== target.to) renames.set(spec.name, target.to)
      // An aliased okAsync/errAsync keeps its local name; its call sites are flagged below.
      if ((spec.name === "okAsync" || spec.name === "errAsync") && spec.local !== spec.name) asyncCtors.push(local)
      const mapped = { type: spec.type || target.type, name: target.to, local }
      const key = `${mapped.name} as ${mapped.local}`
      const prev = core.get(key)
      // A value import wins over a type-only duplicate of the same binding.
      if (prev === undefined || (prev.type && !mapped.type)) core.set(key, mapped)
    }
    const lines = []
    if (core.size > 0) {
      const names = [...core.values()].map((s) => specText(s, declType)).join(", ")
      lines.push(`import ${declType ? "type " : ""}{ ${names} } from ${quote}@friday-friday/core${quote}`)
    }
    if (kept.length > 0) {
      lines.push(`import ${declType ? "type " : ""}{ ${kept.join(", ")} } from ${quote}neverthrow${quote}`)
    }
    return lines.join("\n")
  })

  const otherImport = OTHER_IMPORT_RE.test(out)
  if (!touched && !otherImport) return { out: src, flags: [] }

  // Rename unaliased identifiers outside import lines (ResultAsync → AsyncResult, okAsync → ok).
  const isImportLine = (line) => /^import\s/.test(line)
  const lines = out.split("\n").map((line) =>
    isImportLine(line)
      ? line
      : [...renames].reduce((acc, [from, to]) => acc.replace(new RegExp(`\\b${from}\\b`, "g"), to), line)
  )

  // Collect hints per line, against the ORIGINAL line text for okAsync/errAsync call sites.
  const srcLines = src.split("\n")
  const hintsAt = new Map()
  const add = (i, hint) => {
    const list = hintsAt.get(i) ?? []
    if (!list.includes(hint)) list.push(hint)
    hintsAt.set(i, list)
  }
  const offset = lines.length - srcLines.length // import rewrites can add/remove lines at the top
  lines.forEach((line, i) => {
    if (line.trim().startsWith(REVIEW)) return // a flag from an earlier run
    if (isImportLine(line)) {
      if (otherImport && OTHER_IMPORT_RE.test(line)) add(i, "default/namespace import of neverthrow: migrate by hand")
      return
    }
    for (const m of line.matchAll(METHOD_RE)) add(i, `.${m[1]}(): ${METHOD_HINTS.get(m[1])}`)
    for (const m of line.matchAll(STATIC_RE)) add(i, `${m[0]}: ${STATIC_HINTS.get(m[1])}`)
    for (const name of leftovers) {
      if (new RegExp(`\\b${name}\\b`).test(line)) add(i, `\`${name}\` is still imported from neverthrow`)
    }
    const before = srcLines[i - offset] ?? ""
    for (const ctor of ["okAsync", "errAsync"]) {
      if (renames.has(ctor) && new RegExp(`\\b${ctor}\\s*\\(`).test(before)) {
        add(i, `${ctor}(…) is now core's synchronous \`${renames.get(ctor)}\`; wrap in Promise.resolve(…) where an AsyncResult is expected`)
      }
    }
    for (const local of asyncCtors) {
      if (new RegExp(`\\b${local}\\s*\\(`).test(line)) {
        add(i, `${local}(…) is now synchronous; wrap in Promise.resolve(…) where an AsyncResult is expected`)
      }
    }
  })

  // Insert the REVIEW comments (bottom-up so indices stay valid); skip lines already flagged.
  for (const i of [...hintsAt.keys()].sort((a, b) => b - a)) {
    if (lines[i - 1]?.trim().startsWith(REVIEW)) continue
    const indent = /^\s*/.exec(lines[i])[0]
    lines.splice(i, 0, `${indent}${REVIEW} ${hintsAt.get(i).join("; ")}`)
  }
  // Report each flag against the flagged code line in the OUTPUT (the line below its comment).
  const flags = []
  lines.forEach((line, i) => {
    const at = line.indexOf(REVIEW)
    if (at !== -1) flags.push({ line: i + 2, hint: line.slice(at + REVIEW.length).trim() })
  })
  return { out: lines.join("\n"), flags }
}

function main(argv) {
  const write = argv.includes("--write")
  const files = argv.filter((a) => !a.startsWith("--"))
  if (files.length === 0) {
    console.error("usage: node tooling/codemods/neverthrow-imports.mjs [--write] <files...>")
    return 1
  }
  let changed = 0
  let flagged = 0
  for (const file of files) {
    const src = readFileSync(file, "utf8")
    const { out, flags } = transform(src)
    if (out === src) continue
    changed++
    if (write) writeFileSync(file, out)
    console.log(`${write ? "rewrote" : "would rewrite"} ${file}`)
    for (const { line, hint } of flags) console.log(`  ${file}:${line}: REVIEW ${hint}`)
    flagged += flags.length
  }
  console.log(
    `${changed} file(s) ${write ? "rewritten" : "would be rewritten"}; ${flagged} line(s) flagged for REVIEW.`
  )
  return 0
}

if (import.meta.main === true || process.argv[1]?.endsWith("neverthrow-imports.mjs")) {
  process.exitCode = main(process.argv.slice(2))
}
