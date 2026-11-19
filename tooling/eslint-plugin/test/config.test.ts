/**
 * Issue #43: the custom rules are "enforced repo-wide" (AGENTS.md), so the lint gate must
 * reach app code in examples/, where the redirect trap actually lives (Design Report §5.1),
 * not only packages/*\/src. Seam: the flat config the `lint` script runs, resolved by ESLint.
 */
import { ESLint } from "eslint"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..", "..")
const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, "tooling/eslint-plugin/eslint.config.js") })

const RULES = [
  "@friday-friday/must-use-result",
  "@friday-friday/no-try-around-redirect",
  "@friday-friday/no-instanceof-tagged-error"
] as const

const rulesFor = async (file: string): Promise<Record<string, unknown>> => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- calculateConfigForFile is typed `any` by ESLint
  const config = (await eslint.calculateConfigForFile(join(root, file))) as
    | { rules?: Record<string, unknown> }
    | undefined
  return config?.rules ?? {}
}

describe("eslint.config.js coverage", () => {
  it.each([
    "packages/core/src/index.ts",
    "examples/next-app/src/app/profile/actions.ts",
    "examples/next-app/src/app/profile/profile-form.tsx",
    "examples/next-app/src/app/api/profile/route.ts"
  ])("enables every custom rule as an error for %s", async (file) => {
    const rules = await rulesFor(file)
    for (const rule of RULES) expect(rules[rule]).toEqual([2])
  })

  it("the lint script points ESLint at examples/ as well as packages/", () => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- package.json is the shape npm defines
    const manifest = JSON.parse(readFileSync(join(root, "tooling/eslint-plugin/package.json"), "utf8")) as {
      scripts: { lint: string }
    }
    expect(manifest.scripts.lint.split(/\s+/)).toEqual(expect.arrayContaining(["packages", "examples"]))
  })
})
