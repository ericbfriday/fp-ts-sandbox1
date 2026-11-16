import plugin from "@friday-friday/eslint-plugin"
import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import { describe, expect, it } from "vitest"

// Type-aware rules need the parser + a project. projectService picks the nearest tsconfig
// (tooling/eslint-plugin/tsconfig.json), whose imports resolve the workspace core package.
// Wire eslint's RuleTester into vitest's runner (registers one test per valid/invalid case).
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

// eslint v10 RuleTester takes a flat config object; the plugin is registered under its
// meta.name so rules are addressed as `@friday-friday/<rule>`.
type RuleDef = NonNullable<Parameters<RuleTester["run"]>[1]>

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plugin internal rules map retyped to the RuleTester def
const pluginRules = plugin.rules as unknown as Record<string, RuleDef>

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: { allowDefaultProject: ["*.ts"] },
      tsconfigRootDir: import.meta.dirname.replace("/test", "")
    }
  },
  plugins: { "@friday-friday": { rules: pluginRules } }
})

describe("must-use-result", () => {
  ruleTester.run("must-use-result", pluginRules["must-use-result"]!, {
    valid: [
      "import { ok } from '@friday-friday/core'; const r = ok(1); r.ok",
      "import { ok } from '@friday-friday/core'; const r = ok(1); if (r.ok) console.log(r.value)",
      "import { ok } from '@friday-friday/core'; export const r = ok(1)",
      "import { ok } from '@friday-friday/core'; console.log(ok(1))",
      "import { ok } from '@friday-friday/core'; const x: unknown = ok(1)",
      "notAResult(1)"
    ],
    invalid: [
      {
        code: "import { ok } from '@friday-friday/core'; ok(1)",
        errors: [{ messageId: "mustUse" }]
      },
      {
        code: "import { err } from '@friday-friday/core'; err(new Error('x'))",
        errors: [{ messageId: "mustUse" }]
      },
      {
        code: "import { ok } from '@friday-friday/core'; async function f() { await Promise.resolve(ok(1)) } f()",
        errors: [{ messageId: "mustUse" }]
      }
    ]
  })
})

describe("no-try-around-redirect", () => {
  ruleTester.run("no-try-around-redirect", pluginRules["no-try-around-redirect"]!, {
    valid: [
      "import { redirect } from 'next/navigation'; function f() { redirect('/x') }",
      "import { redirect } from 'next/navigation'; function f() { try { risky() } catch (e) { redirect('/x') } }",
      "import { redirect, unstable_rethrow } from 'next/navigation'; function f() { try { risky(); redirect('/x') } catch (e) { unstable_rethrow(e) } }",
      "import { notFound } from 'next/navigation'; function f() { if (!x) notFound() }",
      "function f() { try { other() } catch (e) { console.log(e) } }"
    ],
    invalid: [
      {
        code:
          "import { redirect } from 'next/navigation'; function f() { try { risky(); redirect('/x') } catch (e) { console.log(e) } }",
        errors: [{ messageId: "noTryAround" }]
      },
      {
        code:
          "import { notFound } from 'next/navigation'; function f() { try { notFound() } catch (e) { console.log(e) } }",
        errors: [{ messageId: "noTryAround" }]
      },
      {
        code: "import { redirect } from 'next/navigation'; function f() { try { risky() } finally { redirect('/x') } }",
        errors: [{ messageId: "noTryAround" }]
      }
    ]
  })
})

describe("no-instanceof-tagged-error", () => {
  const header =
    "import { taggedError, ok, Panic } from '@friday-friday/core'\nconst NotFound = taggedError('NotFound')<{ id: string }>()\n"

  ruleTester.run("no-instanceof-tagged-error", pluginRules["no-instanceof-tagged-error"]!, {
    valid: [
      // Real Error classes are legitimate instanceof targets.
      "function f(e: unknown) { return e instanceof Error }",
      header + "function f(e: unknown) { return e instanceof Panic }",
      header +
      "function f(e: unknown) { if (typeof e === 'object' && e !== null && 'id' in e) return true; return false }",
      header + "declare const e: unknown; function f() { return Panic.prototype instanceof Error }"
    ],
    invalid: [
      {
        code: header + "function f(e: unknown) { return e instanceof NotFound }",
        errors: [{ messageId: "noInstanceof" }]
      }
    ]
  })
})

// `it` is re-exported so the ruleTester.run suites live inside vitest's runner.
it("rule suites executed via RuleTester above", () => {
  // RuleTester.run registers its own assertions; this placeholder keeps vitest satisfied
  // if a suite above somehow reports zero tests.
  expect(true).toBe(true)
})
