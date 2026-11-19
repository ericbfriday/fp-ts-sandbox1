import type { TSESTree } from "@typescript-eslint/utils"
import type { ESLint, Rule, Scope } from "eslint"
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

const RESULT_PRODUCING_SHAPES = new Set<string>([
  "CallExpression",
  "AwaitExpression",
  "ConditionalExpression",
  "ChainExpression",
  "LogicalExpression"
])

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
        // Restrict to expression shapes that plausibly produce a Result; skips directives,
        // assignments (their expression type is the assigned value) and `void` (explicit
        // discard). `svc?.save()` is a ChainExpression and `flag && save()` a
        // LogicalExpression; both are typed as a union that still contains the Result.
        if (!RESULT_PRODUCING_SHAPES.has(expr.type)) return
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

/** Calls that throw a Next.js control-flow sentinel, by module and exported name. The suite's
 * loader helpers call `notFound()`/`forbidden()`/`redirect()` for a matching tag (report §5.1). */
const SENTINELS: ImportTable = new Map([
  ["next/navigation", new Set(["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"])],
  ["@friday-friday/next", new Set(["orNotFound", "orForbidden", "orRedirect"])]
])

/** Calls that rethrow a sentinel they are handed: Next's documented remedy and the suite's
 * cause-chain-walking wrapper around it. */
const REMEDIES: ImportTable = new Map([
  ["next/navigation", new Set(["unstable_rethrow"])],
  ["@friday-friday/next", new Set(["nextRethrow"])]
])

type ImportTable = ReadonlyMap<string, ReadonlySet<string>>

const FUNCTION_TYPES = new Set<string>(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])
const EXIT_TYPES = new Set<string>(["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"])

/** Resolves `id` through the scope chain to the binding it refers to. */
function resolve(context: Rule.RuleContext, id: TSESTree.Identifier): Scope.Variable | undefined {
  for (let scope: Scope.Scope | null = context.sourceCode.getScope(id); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(id.name)
    if (variable !== undefined) return variable
  }
  return undefined
}

/** The import a callee refers to: `name()` / `alias()` for a named import, `ns.name()` for a
 * namespace import. `undefined` for anything that is not a module import (locals, params, globals). */
function importedCallee(
  context: Rule.RuleContext,
  callee: TSESTree.Node
): { source: string; name: string } | undefined {
  const binding = (id: TSESTree.Identifier): { decl: TSESTree.ImportDeclaration; spec: TSESTree.Node } | undefined => {
    const def = resolve(context, id)?.defs[0]
    if (def?.type !== "ImportBinding") return undefined
    return { decl: def.parent as unknown as TSESTree.ImportDeclaration, spec: def.node as unknown as TSESTree.Node }
  }
  if (callee.type === "Identifier") {
    const b = binding(callee)
    if (b === undefined || b.spec.type !== "ImportSpecifier") return undefined
    const imported = b.spec.imported
    return { source: b.decl.source.value, name: imported.type === "Identifier" ? imported.name : imported.value }
  }
  if (
    callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" &&
    callee.property.type === "Identifier"
  ) {
    const b = binding(callee.object)
    if (b === undefined || b.spec.type !== "ImportNamespaceSpecifier") return undefined
    return { source: b.decl.source.value, name: callee.property.name }
  }
  return undefined
}

function calls(context: Rule.RuleContext, node: TSESTree.Node, table: ImportTable): string | undefined {
  if (node.type !== "CallExpression") return undefined
  const target = importedCallee(context, node.callee)
  return target !== undefined && table.get(target.source)?.has(target.name) === true ? target.name : undefined
}

/** Visits `node`'s descendants (never `parent` back-references), stopping where `enter` returns false. */
function walk(node: TSESTree.Node, enter: (n: TSESTree.Node) => boolean): void {
  if (!enter(node)) return
  for (const key of Object.keys(node)) {
    if (key === "parent") continue
    const value = (node as unknown as Record<string, unknown>)[key]
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === "object" && "type" in child) walk(child as TSESTree.Node, enter)
    }
  }
}

/** True when `stmt` can leave the catch block before a later statement runs (exits inside
 * nested functions don't count). Statements that throw through a call are not modelled. */
function canExit(stmt: TSESTree.Statement): boolean {
  let found = false
  walk(stmt, (n) => {
    if (EXIT_TYPES.has(n.type)) found = true
    return !found && !FUNCTION_TYPES.has(n.type)
  })
  return found
}

/**
 * True when the catch clause re-raises whatever it caught on every path: some top-level
 * statement is `throw e` or a remedy call on `e` (alias- and namespace-aware), and no earlier
 * statement can leave the block. ADR-0003: the remedy runs first, `throw e` is the escape hatch.
 */
function catchRethrows(context: Rule.RuleContext, handler: TSESTree.CatchClause): boolean {
  const param = handler.param
  if (param?.type !== "Identifier") return false
  const isParam = (n: TSESTree.Node | undefined): boolean => n?.type === "Identifier" && n.name === param.name
  for (const stmt of handler.body.body) {
    if (stmt.type === "ThrowStatement" && isParam(stmt.argument)) return true
    if (
      stmt.type === "ExpressionStatement" && calls(context, stmt.expression, REMEDIES) !== undefined &&
      stmt.expression.type === "CallExpression" && isParam(stmt.expression.arguments[0])
    ) return true
    if (canExit(stmt)) return false
  }
  return false
}

/**
 * Sentinel calls that run synchronously inside `block`: function bodies are skipped (they run
 * later, outside the try), and a nested try that swallows is left to its own report, while one
 * whose catch rethrows passes its block's sentinels through to the enclosing try.
 */
function sentinelCalls(context: Rule.RuleContext, block: TSESTree.Node): Array<{ node: TSESTree.Node; name: string }> {
  const found: Array<{ node: TSESTree.Node; name: string }> = []
  walk(block, (n) => {
    if (FUNCTION_TYPES.has(n.type)) return false
    if (n.type === "TryStatement" && n.handler !== null && n !== block) {
      if (catchRethrows(context, n.handler)) found.push(...sentinelCalls(context, n.block))
      found.push(...sentinelCalls(context, n.handler.body))
      if (n.finalizer !== null) found.push(...sentinelCalls(context, n.finalizer))
      return false
    }
    const name = calls(context, n, SENTINELS)
    if (name !== undefined) found.push({ node: n, name })
    return true
  })
  return found
}

const noTryAroundRedirect: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "redirect()/notFound()/forbidden()/unauthorized() (and the suite's orNotFound/orForbidden/orRedirect) inside a `try` whose catch swallows — they throw Next.js control-flow sentinels",
      recommended: false
    },
    schema: [],
    messages: {
      noTryAround:
        "'{{name}}()' throws a Next.js control-flow sentinel that this catch swallows. Call it outside the try, or start the catch with unstable_rethrow(e) / nextRethrow(e) (or throw e)."
    }
  },
  create(context) {
    return {
      // Only the try block is guarded by its own catch: the finalizer and the catch body are
      // not, and a try without a catch swallows nothing (report §5.1, ADR-0003).
      TryStatement(node): void {
        const t = node as unknown as TSESTree.TryStatement
        if (t.handler === null || catchRethrows(context, t.handler)) return
        for (const call of sentinelCalls(context, t.block)) {
          context.report({
            node: call.node as unknown as Rule.Node,
            messageId: "noTryAround",
            data: { name: call.name }
          })
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
        // Any right-hand side shape (`NotFound`, `Errors.NotFound`, an alias): the checker
        // decides, not the syntax.
        if (isErrorFactoryType(context, node.right as unknown as TSESTree.Node)) {
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
