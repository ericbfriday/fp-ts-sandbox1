import type { TSESTree } from "@typescript-eslint/utils"
import type { ESLint, Rule } from "eslint"
import type { Node as TSNode, Program, TypeChecker } from "typescript"

// The AST traversal below intentionally sits at the boundary between ESLint's and
// TypeScript's node universes: the casts are each guarded by structural checks, and the
// eslint/ts enums are compared by literal value. File-scoped oxlint disables cover those
// inherent patterns (ADR-0003).
// oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unsafe-enum-comparison, typescript/no-unsafe-enum-assignment, typescript/consistent-type-imports -- guarded AST-universe casts in a lint-rule implementation

const RESULT_TYPE_NAMES = new Set(["Result", "AsyncResult", "Ok", "Err"])

type Services = {
  checker: TypeChecker
  toTSNode: (n: TSESTree.Node) => TSNode
}

function services(context: Rule.RuleContext): Services | undefined {
  const parserServices = context.sourceCode.parserServices
  if (parserServices === undefined || parserServices.program === undefined) return undefined
  const program: Program = parserServices.program
  return {
    checker: program.getTypeChecker(),
    toTSNode: (n) => parserServices.esTreeNodeToTSNodeMap.get(n)
  }
}

/** True when the node's type is (a union containing) a type whose symbol/alias name is in `names`. */
function typeMatchesNames(context: Rule.RuleContext, node: TSESTree.Node, names: Set<string>): boolean {
  const svc = services(context)
  if (svc === undefined) return false
  const type = svc.checker.getTypeAtLocation(svc.toTSNode(node))
  const parts = type.isUnion() ? type.types : [type]
  return parts.some((part) => {
    const name = part.aliasSymbol?.name ?? part.symbol?.name
    return name !== undefined && names.has(name)
  })
}

/** True when the node's type is (a union containing) `Result` or `AsyncResult`. */
function isResultType(context: Rule.RuleContext, node: TSESTree.Node): boolean {
  return typeMatchesNames(context, node, RESULT_TYPE_NAMES)
}

/** True when the node's type is (a union containing) an `ErrorFactory`. */
function isErrorFactoryType(context: Rule.RuleContext, node: TSESTree.Node): boolean {
  return typeMatchesNames(context, node, new Set(["ErrorFactory"]))
}

// ---------------------------------------------------------------------------
// must-use-result
// ---------------------------------------------------------------------------

const mustUseResult: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Flags discarded Result/AsyncResult expressions — TypeScript does not force consumption",
      recommended: false
    },
    schema: [],
    messages: {
      mustUse:
        "A Result was discarded. Handle both branches (match/matchTag), unwrap explicitly (unwrapOr), or return it."
    }
  },
  create(context) {
    return {
      ExpressionStatement(node): void {
        const expr = node.expression
        // Restrict to expression shapes that plausibly produce a Result; skips directives and
        // assignments (their expression type is the assigned value).
        if (
          expr.type !== "CallExpression" && expr.type !== "AwaitExpression" && expr.type !== "ConditionalExpression"
        ) {
          return
        }
        if (isResultType(context, expr as TSESTree.Node)) {
          context.report({ node, messageId: "mustUse" })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// no-try-around-redirect
// ---------------------------------------------------------------------------

const NAVIGATION_SENTINELS = new Set(["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"])

/** Walk `node`, returning the name of the first sentinel call found (cycles skipped). */
function findSentinelCall(node: unknown, sentinels: Set<string>): string | undefined {
  if (node === null || node === undefined || typeof node !== "object") return undefined
  const visited = new Set<unknown>()
  const visit = (n: TSESTree.Node): string | undefined => {
    if (visited.has(n)) return undefined
    visited.add(n)
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && sentinels.has(n.callee.name)) {
      return n.callee.name
    }
    for (const key of Object.keys(n)) {
      // `parent` back-references create cycles; never walk them.
      if (key === "parent") continue
      const value = (n as unknown as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child !== null && typeof child === "object" && "type" in child) {
            const found = visit(child as TSESTree.Node)
            if (found !== undefined) return found
          }
        }
      } else if (value !== null && typeof value === "object" && "type" in value) {
        const found = visit(value as TSESTree.Node)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return visit(node as TSESTree.Node)
}

/** True when `handler` contains an `unstable_rethrow` call — the documented remedy that makes
 * sentinel-throwing code inside the `try` safe (Next.js docs / report §5.1). */
function handlerCallsUnstableRethrow(handler: TSESTree.Node | undefined | null): boolean {
  return handler !== undefined && handler !== null &&
    findSentinelCall(handler, new Set(["unstable_rethrow"])) !== undefined
}

const noTryAroundRedirect: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "redirect()/notFound()/forbidden()/unauthorized() inside `try` blocks get swallowed — they throw Next.js control-flow sentinels",
      recommended: false
    },
    schema: [],
    messages: {
      noTryAround:
        "'{{name}}()' throws a Next.js control-flow sentinel that this try/catch swallows. Call it outside the try, or call unstable_rethrow first in every catch."
    }
  },
  create(context) {
    const sentinels = new Set<string>()
    return {
      ImportDeclaration(node): void {
        if (node.source.value !== "next/navigation") return
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue
          const imported = spec.imported
          if (imported.type === "Identifier" && NAVIGATION_SENTINELS.has(imported.name)) {
            sentinels.add(spec.local.name)
          }
        }
      },
      TryStatement(node): void {
        // Try block/finalizer sentinel calls are flagged ONLY when the catch handler does not
        // call unstable_rethrow \u2014 that call is the documented remedy (report \u00a75.1) which
        // re-raises the sentinel before any mapping can swallow it.
        if (handlerCallsUnstableRethrow(node.handler as unknown as TSESTree.Node)) return
        const parts: Array<unknown> = [node.block]
        if (node.finalizer !== null && node.finalizer !== undefined) parts.push(node.finalizer)
        for (const part of parts) {
          const found = findSentinelCall(part, sentinels)
          if (found !== undefined) {
            context.report({
              node,
              messageId: "noTryAround",
              data: { name: found }
            })
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// no-instanceof-tagged-error
// ---------------------------------------------------------------------------

const noInstanceofTaggedError: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "`instanceof` fails across duplicate module copies — tagged errors are plain data; use the factory's structural `.is()` guard",
      recommended: false
    },
    schema: [],
    messages: {
      noInstanceof:
        "Tagged errors are plain data — `instanceof` fails across duplicate module copies. Use the factory's structural `.is()` guard instead."
    }
  },
  create(context) {
    return {
      BinaryExpression(node): void {
        if (node.operator !== "instanceof") return
        if (node.right.type === "Identifier" && isErrorFactoryType(context, node.right as unknown as TSESTree.Node)) {
          context.report({ node, messageId: "noInstanceof" })
        }
      }
    }
  }
}

const rules: Record<string, Rule.RuleModule> = {
  "must-use-result": mustUseResult,
  "no-try-around-redirect": noTryAroundRedirect,
  "no-instanceof-tagged-error": noInstanceofTaggedError
}

const plugin: ESLint.Plugin = {
  meta: { name: "@friday-friday/eslint-plugin", version: "0.0.0" },
  rules
}

export default plugin
