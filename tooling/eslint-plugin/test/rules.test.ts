import plugin from "@friday-friday/eslint-plugin"
import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import { describe, it, vi } from "vitest"

// Type-aware rules need the parser + a project. projectService picks the nearest tsconfig
// (tooling/eslint-plugin/tsconfig.json), whose imports resolve the workspace core package.
// Wire eslint's RuleTester into vitest's runner (registers one test per valid/invalid case).
// The first type-aware case builds the TypeScript program through projectService, which
// takes several seconds on a cold or loaded machine; the 5 s default made it flaky.
vi.setConfig({ testTimeout: 30_000 })

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
  const saveHeader = "import type { Result } from '@friday-friday/core'\n" +
    "declare function save(): Result<number, string>\n" +
    "declare const svc: { save(): Result<number, string> } | undefined\n" +
    "declare const flag: boolean\n"
  // #105: un-awaited promises of a Result, spelled without the `AsyncResult` alias.
  const loadHeader = "import type { Result } from '@friday-friday/core'\n" +
    "declare function load(): Promise<Result<number, string>>\n" +
    "declare function count(): Promise<number>\n" +
    "declare const repo: { load(): Promise<Result<number, string>> } | undefined\n" +
    "declare const thenable: PromiseLike<Result<number, string>>\n"

  ruleTester.run("must-use-result", pluginRules["must-use-result"]!, {
    valid: [
      // #105: an explicit discard, an awaited-and-used value, a returned promise, and a promise of
      // a non-Result (no-floating-promises' job, not this rule's) all stay valid.
      { name: "void load()", code: loadHeader + "void load()" },
      { name: "awaited and used", code: loadHeader + "async function f() { const r = await load(); return r.ok }" },
      { name: "returned promise", code: loadHeader + "function f() { return load() }" },
      { name: "Promise<number> is not a Result", code: loadHeader + "count()" },
      "import { ok } from '@friday-friday/core'; const r = ok(1); r.ok",
      "import { ok } from '@friday-friday/core'; const r = ok(1); if (r.ok) console.log(r.value)",
      "import { ok } from '@friday-friday/core'; export const r = ok(1)",
      "import { ok } from '@friday-friday/core'; console.log(ok(1))",
      "import { ok } from '@friday-friday/core'; const x: unknown = ok(1)",
      "notAResult(1)",
      // `void` is the explicit discard.
      { name: "explicit discard void save()", code: saveHeader + "void save()" }
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
      },
      // Optional call: the statement is a ChainExpression typed `Result | undefined`.
      { name: "optional call svc?.save()", code: saveHeader + "svc?.save()", errors: [{ messageId: "mustUse" }] },
      // Short-circuit: the statement is a LogicalExpression typed `false | Result`.
      { name: "short-circuit flag && save()", code: saveHeader + "flag && save()", errors: [{ messageId: "mustUse" }] },
      // #105: un-awaited Promise<Result> without the AsyncResult alias.
      { name: "un-awaited Promise<Result>", code: loadHeader + "load()", errors: [{ messageId: "mustUse" }] },
      {
        name: "un-awaited async function returning a Result",
        code: "import { ok } from '@friday-friday/core'\nasync function f() { return ok(1) }\nf()",
        errors: [{ messageId: "mustUse" }]
      },
      {
        name: "optional call repo?.load() typed Promise<Result> | undefined",
        code: loadHeader + "repo?.load()",
        errors: [{ messageId: "mustUse" }]
      },
      {
        name: "PromiseLike<Result> in a short-circuit",
        code: loadHeader + "declare const flag: boolean\nflag && thenable",
        errors: [{ messageId: "mustUse" }]
      },
      {
        name: "short-circuit svc === undefined || svc.save()",
        code: saveHeader + "svc === undefined || svc.save()",
        errors: [{ messageId: "mustUse" }]
      }
    ]
  })
})

describe("no-try-around-redirect", () => {
  const nav = "import { redirect, notFound, unstable_rethrow } from 'next/navigation'\n"
  const err = (n = 1): Array<{ messageId: string }> => Array.from({ length: n }, () => ({ messageId: "noTryAround" }))

  ruleTester.run("no-try-around-redirect", pluginRules["no-try-around-redirect"]!, {
    valid: [
      "import { redirect } from 'next/navigation'; function f() { redirect('/x') }",
      "import { redirect } from 'next/navigation'; function f() { try { risky() } catch (e) { redirect('/x') } }",
      "import { redirect, unstable_rethrow } from 'next/navigation'; function f() { try { risky(); redirect('/x') } catch (e) { unstable_rethrow(e) } }",
      "import { notFound } from 'next/navigation'; function f() { if (!x) notFound() }",
      "function f() { try { other() } catch (e) { console.log(e) } }",
      // No catch clause: nothing swallows the sentinel.
      {
        name: "try/finally without catch",
        code: nav + "function f() { try { redirect('/x') } finally { cleanup() } }"
      },
      // The finalizer runs after the catch; this try cannot catch what it throws.
      { name: "redirect inside finally", code: nav + "function f() { try { risky() } finally { redirect('/x') } }" },
      {
        name: "redirect inside finally after a swallowing catch",
        code: nav + "function f() { try { risky() } catch (e) { console.log(e) } finally { redirect('/x') } }"
      },
      // The documented remedy, first or after side-effect-only statements.
      {
        name: "unstable_rethrow(e) then mapping",
        code: nav + "function f() { try { redirect('/x') } catch (e) { unstable_rethrow(e); console.log(e) } }"
      },
      {
        name: "aliased unstable_rethrow import",
        code: "import { redirect, unstable_rethrow as rethrowNext } from 'next/navigation'\n" +
          "function f() { try { redirect('/x') } catch (e) { rethrowNext(e); console.log(e) } }"
      },
      {
        name: "namespace-imported unstable_rethrow",
        code: "import * as nav from 'next/navigation'\n" +
          "function f() { try { nav.redirect('/x') } catch (e) { nav.unstable_rethrow(e); console.log(e) } }"
      },
      {
        name: "suite rethrow helper nextRethrow",
        code: nav + "import { nextRethrow } from '@friday-friday/next'\n" +
          "function f() { try { redirect('/x') } catch (e) { nextRethrow(e); console.log(e) } }"
      },
      {
        name: "aliased suite rethrow helper",
        code: nav + "import { nextRethrow as rethrow } from '@friday-friday/next'\n" +
          "function f() { try { redirect('/x') } catch (e) { rethrow(e); console.log(e) } }"
      },
      // ADR-0003's escape hatch: rethrow the caught value.
      { name: "catch (e) { throw e }", code: nav + "function f() { try { redirect('/x') } catch (e) { throw e } }" },
      {
        name: "log, then throw e",
        code: nav + "function f() { try { redirect('/x') } catch (e) { console.error(e); throw e } }"
      },
      // A function defined in the try runs later, outside it.
      {
        name: "callback defined in the try but not called there",
        code: nav + "function f() { try { const cb = () => redirect('/x'); return cb } catch (e) { console.log(e) } }"
      },
      {
        name: "function declaration inside the try",
        code: nav + "function f() { try { function go() { notFound() } return go } catch (e) { console.log(e) } }"
      },
      // Only imports from next/navigation (or the suite) are sentinels.
      {
        name: "parameter that shadows the sentinel name",
        code: "function f(redirect: (to: string) => void) { try { redirect('/x') } catch (e) { console.log(e) } }"
      },
      {
        name: "same name imported from another module",
        code:
          "import { redirect } from './router'\nfunction f() { try { redirect('/x') } catch (e) { console.log(e) } }"
      },
      {
        name: "inner try rethrows to an outer try/finally",
        code: nav + "function f() { try { try { redirect('/x') } catch (e) { throw e } } finally { cleanup() } }"
      }
    ],
    invalid: [
      {
        code:
          "import { redirect } from 'next/navigation'; function f() { try { risky(); redirect('/x') } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        code:
          "import { notFound } from 'next/navigation'; function f() { try { notFound() } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        name: "aliased sentinel import",
        code:
          "import { redirect as go } from 'next/navigation'\nfunction f() { try { go('/x') } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        name: "namespace-imported sentinel nav.redirect()",
        code:
          "import * as nav from 'next/navigation'\nfunction f() { try { nav.redirect('/x') } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        name: "suite loaders orNotFound / orForbidden / orRedirect",
        code: "import { orNotFound, orForbidden, orRedirect } from '@friday-friday/next'\ndeclare const r: any\n" +
          "function f() { try { orNotFound(r); orForbidden(r); orRedirect(r, '/login') } catch (e) { console.log(e) } }",
        errors: [
          { messageId: "noTryAround", data: { name: "orNotFound" } },
          { messageId: "noTryAround", data: { name: "orForbidden" } },
          { messageId: "noTryAround", data: { name: "orRedirect" } }
        ]
      },
      {
        name: "namespace-imported suite loader",
        code: "import * as fl from '@friday-friday/next'\ndeclare const r: any\n" +
          "function f() { try { return fl.orNotFound(r) } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        name: "remedy only on one branch",
        code: nav +
          "function f() { try { notFound() } catch (e) { if (Math.random() > 2) { unstable_rethrow(e) } return 1 } }",
        errors: err()
      },
      {
        name: "early return before the remedy",
        code: nav + "function f(x: boolean) { try { notFound() } catch (e) { if (x) return 1; unstable_rethrow(e) } }",
        errors: err()
      },
      {
        name: "remedy called on a different value",
        code: nav +
          "declare const other: unknown\nfunction f() { try { redirect('/x') } catch (e) { unstable_rethrow(other) } }",
        errors: err()
      },
      {
        name: "wrapping throw loses the sentinel",
        code: nav + "function f() { try { redirect('/x') } catch (e) { throw new Error('wrapped', { cause: e }) } }",
        errors: err()
      },
      {
        name: "optional catch binding",
        code: nav + "function f() { try { redirect('/x') } catch { console.log('x') } }",
        errors: err()
      },
      {
        name: "every sentinel call is reported",
        code: nav + "function f(x: boolean) { try { if (x) redirect('/a'); notFound() } catch (e) { console.log(e) } }",
        errors: err(2)
      },
      {
        name: "after an await in the same try",
        code: nav + "async function f() { try { await save(); redirect('/x') } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        name: "inner try rethrows into an outer try that swallows",
        code: nav +
          "function f() { try { try { redirect('/x') } catch (e) { throw e } } catch (e) { console.log(e) } }",
        errors: err()
      },
      {
        name: "nested swallowing tries report once",
        code: nav +
          "function f() { try { try { redirect('/x') } catch (e) { console.log(e) } } catch (e) { console.log(e) } }",
        errors: err()
      }
    ]
  })
})

describe("no-instanceof-tagged-error", () => {
  const header =
    "import { taggedError, ok, Panic } from '@friday-friday/core'\nconst NotFound = taggedError('NotFound')<{ id?: string }>()\n"

  ruleTester.run("no-instanceof-tagged-error", pluginRules["no-instanceof-tagged-error"]!, {
    valid: [
      // Real Error classes are legitimate instanceof targets.
      "function f(e: unknown) { return e instanceof Error }",
      header + "function f(e: unknown) { return e instanceof Panic }",
      header +
      "function f(e: unknown) { if (typeof e === 'object' && e !== null && 'id' in e) return true; return false }",
      header + "declare const e: unknown; function f() { return Panic.prototype instanceof Error }",
      {
        name: "member right-hand side that is a real Error class",
        code: header + "const Classes = { Error }\nfunction f(e: unknown) { return e instanceof Classes.Error }"
      }
    ],
    invalid: [
      {
        code: header + "function f(e: unknown) { return e instanceof NotFound }",
        errors: [{ messageId: "noInstanceof" }]
      },
      {
        name: "member right-hand side x instanceof Errors.NotFound",
        code: header + "const Errors = { NotFound }\nfunction f(e: unknown) { return e instanceof Errors.NotFound }",
        errors: [{ messageId: "noInstanceof" }]
      },
      {
        name: "aliased factory",
        code: header + "const Alias = NotFound\nfunction f(e: unknown) { return e instanceof Alias }",
        errors: [{ messageId: "noInstanceof" }]
      }
    ]
  })
})
