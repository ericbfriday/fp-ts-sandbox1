/**
 * #91 (ADR-0005): core owns the fixed vocabulary, so next's src names a fixed tag only through
 * core's (or schema's) factory `.tag`, never as a string literal that could drift from it.
 */
import {
  Conflict,
  DbUnavailable,
  Forbidden,
  NetworkError,
  NotFound,
  Timeout,
  Unauthenticated
} from "@friday-friday/core"
import { ValidationFailure } from "@friday-friday/schema"
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const fixedTags: ReadonlySet<string> = new Set(
  [NotFound, Conflict, Forbidden, Unauthenticated, Timeout, NetworkError, DbUnavailable, ValidationFailure].map(
    (f) => f.tag
  )
)

const srcDir = new URL("../src/", import.meta.url)

/** Comments and string literals in one pass, so a quote inside a comment (or `//` inside a string)
 * can't fool either; template literals are scanned whole. Returns each string literal's body. */
const stringLiterals = (code: string): Array<string> =>
  Array.from(
    code.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`/g),
    (m) => m[1] ?? m[2] ?? m[3]
  ).filter((s): s is string => s !== undefined)

describe("next src names fixed tags only through the factories (ADR-0005)", () => {
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"))

  it("scans every src file", () => {
    expect(files).toContain("index.ts")
  })

  it.each(files)("%s has no fixed-tag string literal", (file) => {
    const code = readFileSync(new URL(file, srcDir), "utf8")
    expect(stringLiterals(code).filter((s) => fixedTags.has(s))).toEqual([])
  })

  it("the scanner finds a fixed-tag literal in code but not in a comment", () => {
    const probe = `// "NotFound"\n/* 'Forbidden' */\nconst t = { tag: "Unauthenticated" }`
    expect(stringLiterals(probe).filter((s) => fixedTags.has(s))).toEqual(["Unauthenticated"])
  })
})
