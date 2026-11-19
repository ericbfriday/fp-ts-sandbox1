# DEVELOPER.md — working in this repo

How the codebase is organized, why it looks the way it does, and how to work on it without fighting the tools.

## The driving philosophy

1. **The adapters are the product.** Result libraries already exist (byethrow, better-result, unthrown, Effect 4). What none of them does is absorb the _framework-boundary traps_ — Next.js sentinel throws, TanStack Query's throw-to-error contract, Better Auth's mixed throw-and-tuple API, tRPC's error channel, Hono's status inference. Every design decision serves that.
2. **Plain data survives every boundary.** Results are `{ ok: true, value } | { ok: false, error }` — no classes, no prototypes, no symbols on instances. They come back identical after `JSON.stringify`, `structuredClone`, RSC payloads, `"use cache"` and tRPC transformers. Tagged errors are plain objects with a `_tag` and a structural `.is()` guard, because `instanceof` breaks across duplicate module copies (Better Auth and TanStack Form both document this).
3. **Defects are thrown, not values.** A third union member forces every consumer, adapter and wire format to handle three states. Unexpected throws become `Panic` (original as `cause`) and adapters sanitize them into `InternalDefect` at the edge.
4. **No HKTs, ever.** Everything is monomorphic over `Result`. That is what keeps hover text readable and TS2589 away. `pipe`/`flow` are explicit overloads (16/12), never recursive types.
5. **Triage at boundaries.** `tryAsync(fn, { catch, rethrow })`: the `catch` maps an unknown throw to a domain error, or returns `undefined` = defect = rethrow. Framework sentinels (Next.js `redirect()`/`notFound()`) are rethrown FIRST via pre-bound `rethrow` functions — they are control flow, not errors.
6. **Signals flow down.** Cancellation-capable helpers take `{ signal }` and FORWARD it into user callbacks so underlying work can observe cancellation. Pure combinators don't (nothing to cancel); callers bind their signal in the closure.
7. **Zero vendor dependencies.** Validation is Standard Schema types-only. Zod/Valibot/ArkType appear in devDependencies of tests as fixtures, never in runtime imports.
8. **Enforce by lint, not by hope.** TypeScript doesn't force Result consumption; the local ESLint plugin does. See `tooling/eslint-plugin`.
9. **Explicit over clever.** Dual dispatch is `arguments.length`, not type sniffing. Casts exist only at guarded AST/wire boundaries, each with a scoped disable comment and a reason.

Locked decisions: `IDEA.md` §4. To change one, write a note in `docs/decisions/` first (see `2026-11-16-async-signal-handling.md` for the format).

## Layout

```
packages/core    @friday-friday/core — sync surface + /async + /gen + /wire subpaths
packages/schema  @friday-friday/schema — Standard Schema → Result
packages/next    @friday-friday/next — Next.js adapter (react-server/default/client conditions)
packages/...     Phase 2+: query, better-auth, http, otel, hono, trpc, tanstack-start, effect, db, env
tooling/eslint-plugin  @friday-friday/eslint-plugin — the three type-aware rules (ADR-0003)
examples/next-app      live proof of the Next.js adapter (issue #9)
docs/            plan (living), spec (RFC-0001), adr/, decisions/, agents/, research
```

Boundary rules: `core` imports nothing; `schema` imports only `core`; adapters import `core` (+ `schema`) and their framework peers, never each other. Core and schema are peer dependencies, so an app has one copy of each; recognise a defect with `isPanic`, never `instanceof Panic`, because a second copy of core fails `instanceof` (ADR-0006).

## Commands

All via pnpm at the root (see also `README.md`):

- `pnpm run ci` — the full local gate: lint, typecheck (TS 7 only; the 6.0/7.1-beta matrix runs in CI), test, size, smoke, source smoke (`smoke:source`), example build. **Run this before pushing.** Not `pnpm ci`: in pnpm 12 that is the built-in clean install and never runs the script.
- `pnpm test` — Vitest runtime + `--typecheck` type tests; `pnpm test <file>` filters
- `pnpm --filter "@friday-friday/<pkg>" exec tsc --noEmit -p tsconfig.json` — per-package check

## Testing conventions

- Runtime tests: `<pkg>/test/<area>.test.ts`. Type tests: `<pkg>/test/<area>.test-d.ts` with `expectTypeOf` + the **annotated-const pattern** (`const r: Expected = actual`) — expectTypeOf on Promise-wrapped unions trips its brand probe, and the assignment is the real inference check.
- Property laws (fast-check) for combinator math; wire contracts (`JSON.parse(JSON.stringify(x))` + `structuredClone`) for every public output; `fc.asyncProperty` for async predicates.
- Framework APIs are mocked with sentinel-accurate fakes (see `packages/next/test/next.test.ts`'s `vi.mock("next/navigation")`).

## Known TS 7.0.2 quirks (re-check at 7.1 stable, planned 24 Nov 2026)

- Root `tsc` mis-resolves `T` for repeated/position-dependent data-first `matchTag` calls in one function body; vitest's own typecheck disagrees. Route tagged-dispatch tests through `pipe`/data-last forms; type coverage lives in `*.test-d.ts`.
- `const` type parameters can mangle element unions (`all()` inferred Err-only). Use a variadic-tuple constraint plus a generic-array overload instead.
- Multi-step `gen` bodies need the generator return-type annotation (`Generator<Err<E>, T, unknown>`); single-source bodies infer.
- expect-type's `toEqualTypeOf` brand probe trips on Promise-wrapped unions — use the annotated-const pattern.
- 7.1-beta treats textually identical conditional types from DIFFERENT declarations as unrelated — declare the conditional once as a shared alias and reference it from every site (see `packages/query`'s `QueryFnReturn`).
- TS2589 is not theoretical: `respond`'s status-literal return types degraded generic inference for LATER declarations in the same file (observed in `packages/hono`'s first test draft). The report's guidance is load-bearing — per-concern sub-apps, and declare heavy-inference helpers before instantiation-heavy ones.

## Lint directives (both tools run)

- oxlint rules: `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reason`
- ESLint rules: `// eslint-disable-next-line typescript/no-unsafe-type-assertion -- reason`
- Each tool errors on the other's unknown rule ids; when a line needs both, stack both comments.
- `no-unsafe-type-assertion` reports at the EXPRESSION START of multi-line statements — put the disable directly above the statement's first line, not above the cast token.

## Supply-chain policy

- CI enforces pnpm's `minimumReleaseAge`; a dependency published within the window fails `pnpm install --frozen-lockfile` even when it installs locally. Pin vendor devDeps to an exact version older than the window and drop any `minimumReleaseAgeExclude` workaround (it is not honored by CI's check). See `hono@4.13.18` in `packages/hono`.
- Peers that a package imports at runtime (better-auth, @opentelemetry/api, hono) must appear in that package's `.size-limit.json` entry as `ignore` — the report's adapter budget is "≤ 2 kB excluding peers".

## Report-vs-reality errata (verified against vendored sources)

- No hono version ships `sValidator` (checked 4.13.18/4.13.19 + 5.0.0-rc.1 exports maps) — `sv` in `@friday-friday/hono` builds on hono `validator` + Standard Schema directly.
- better-auth `databaseHooks.*.before` is `Promise<boolean | void | { data }>` — the runner checks `=== false` and `"data" in result` only; there is no `abort` field (verified in better-call/better-auth 1.7.25 sources).
- tRPC brands its middleware marker (`"middlewareMarker" & { __brand }`), so a structural middleware result type cannot be expressed outside tRPC's own types — `resultMiddleware` asserts at one boundary and the runtime contract is proven by wire tests through the real fetch adapter.

## Adding a package

1. `packages/<name>/package.json` — `@friday-friday/<name>`, core (+schema) as **peers** `workspace:^` plus devDeps `workspace:*`, never `dependencies` (ADR-0006; `tooling/gates` checks it), framework vendors as **peers** with conservative ranges (lower bound = oldest CI-matrix version), vendors as devDeps for fixtures.
2. `tsconfig.json` extending `../../tsconfig.base.json`, `tsdown.config.ts` (see `packages/core`), `test/` suite, size-limit entry (≤ 2 kB adapters) in `.size-limit.json`.
3. Wire docs: README table row + plan checkbox. Root `tsconfig.json`/vitest globs pick everything else up automatically.
4. Peer caveat: some frameworks (next@16.4) ship empty `exports` maps, so their dist cannot import them under plain Node. The smoke stubs just those modules with an in-thread resolve hook (`module.registerHooks`; see `packages/next/test/smoke.mjs`) and keeps everything else real; cover runtime behavior in vitest + an example app.
