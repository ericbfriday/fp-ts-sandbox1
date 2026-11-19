/**
 * IDEA §4.10 gate: the bridge imports only `@stability stable` Effect members. Reads the bridge's
 * own source for every `Effect.x` / `Exit.x` / `Cause.x` it touches and checks that member's
 * JSDoc in the installed `effect` (which ships its `src/`), so a new unstable call fails CI.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

const bridge = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
const effectRoot = dirname(createRequire(import.meta.url).resolve("effect/package.json"))

const stabilityOf = (module: string, member: string): string | undefined => {
  const src = readFileSync(join(effectRoot, "src", `${module}.ts`), "utf8")
  const decl = new RegExp(
    `/\\*\\*((?:(?!\\*/)[\\s\\S])*?)\\*/\\s*export (?:declare )?(?:const|function|interface|type) ${member}\\b`
  )
  return decl.exec(src)?.[1]?.match(/@stability (\w+)/)?.[1]
}

describe("Effect stability gate (IDEA §4.10)", () => {
  it("imports only from the `effect` root entry", () => {
    const specifiers = [...bridge.matchAll(/from "(effect[^"]*)"/g)].map((m) => m[1])
    expect(specifiers).toEqual(["effect"])
  })

  const used = [...new Set([...bridge.matchAll(/\b(Effect|Exit|Cause)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`))]

  it("touches at least the members the bridge is known to need", () => {
    expect(used).toEqual(expect.arrayContaining(["Effect.runPromiseExit", "Exit.isSuccess"]))
  })

  it.each(used)("%s is @stability stable", (qualified) => {
    const [module = "", member = ""] = qualified.split(".")
    expect(stabilityOf(module, member)).toBe("stable")
  })
})
