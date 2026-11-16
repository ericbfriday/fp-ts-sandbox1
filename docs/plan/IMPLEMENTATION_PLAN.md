# Implementation Plan — `@friday-friday/*` functional-light suite

Sources of truth: `IDEA.md` (brief, §4 locked decisions) · `docs/spec/rfc-0001-core.md` (Phase 0 spec) · `docs/adr/*` (decisions) · Design Report in `docs/` (authoritative research). This file is the working plan; update it as evidence lands.

## Verified evidence baseline (2026-11-16, this machine)

| Fact | Value | Consequence |
|---|---|---|
| TanStack/router#6428 | **OPEN** | Start adapter keeps validate-inside-handler workaround |
| better-auth#7338 | **CLOSED** (no official Effect pkg) | `@friday-friday/effect` + `authCall` is the bridge |
| TypeScript | latest 7.0.2, 7.1 still `beta` (stable planned 24 Nov) | matrix = 6.0 / 7.0 / 7.1-beta |
| next / react | 16.4.6 / 19.3.1 | peers `next >=16.3 <18`, `react >=19.2` |
| better-auth | 1.7.25 | peer `^1.6 \|\| ^1.7` |
| @tanstack/query-core | 5.107.1 | peer `^5` |
| @tanstack/react-start | 1.169.5 | pin `>=1.169` (`.validator()`) |
| hono | 4.13.19 (5.0.0-rc exists) | peer `^4.10 \|\| ^5.0.0-0` |
| @trpc/server·client | 11.28.3 | peer `^11` |
| effect | 4.1.4 | peer `^4.0`, stable modules only |
| @standard-schema/spec | 1.1.0 | types-only dep |
| Prior art | better-result 3.0.1, unthrown 5.12.2, @praha/byethrow 0.13.0 | converters/interop, never deps |

Claude Code 2.1.317, Claude Pro subscription; model aliases `fable` / `opus` / `sonnet` all verified working. No tmux on this host → print-mode (`-p`) orchestration only.

## Delegation model

| Workload | Model | How |
|---|---|---|
| API-surface design, tricky dual typing, core combinators | `fable` (fallback `opus`) | CC `-p` on a feature branch |
| Package implementation, TDD slices | `opus` | CC `-p`, `--permission-mode acceptEdits` + explicit `--allowedTools` |
| Mechanical/well-specified (schema, http, env, CI yaml, docs, codemods) | `sonnet` | CC `-p` |
| Review, wire-level verification, merge to main | Hermes | code-review skill + `pnpm` gates + gh |

Rules: children read repo docs (IDEA.md, RFC, ADRs) — prompts stay lean; each slice = one feature branch → PR → CI → Hermes review → merge to main; no npm publishing, ever, without Eric.

## Phases

### Phase 0 — Spec & decisions ✅ (this commit)
- [x] ADR-0001 pnpm workspaces (no Nx in sandbox)
- [x] ADR-0002 tsdown ESM-only (verification gate in Phase-1 scaffold)
- [x] ADR-0003 linter strategy (POC pending — Oxlint base + local ESLint plugin for 3 custom rules)
- [x] ADR-0004 Vitest + fast-check + size-limit + TS matrix + Actions CI
- [x] RFC-0001 core spec (Result shape, error taxonomy, wire envelope, RFC 9457 mapping)
- [x] Version/issue verification table (above)
- [x] Linter POC → **ADR-0003 Accepted** (PR #10): type-aware Oxlint works on Windows via oxlint-tsgolint; the 3 custom rules can't be Oxlint-native (no type-aware JS plugins) → local ESLint plugin pinned to `typescript ~6.0.3` (typescript-eslint peers `<6.1.0`); re-test at TS 7.1 stable.

### Phase 1 — MVP: `core` + `schema` + `next` + lint rules
Exit criteria (from report §9): size budgets green, TS 6/7/7.1 matrix green, `examples/next-app` runs one feature on Result, redirects survive try/catch.

1. **Scaffold** ✅ (PR #10, issue #2 closed; CI 6/6 green; tsdown gate PASSED; tsconfig.base strict+isolatedDeclarations+erasableSyntaxOnly; Vitest/--typecheck + fast-check + size-limit wired; `.size-limit.json` 600 B/3 kB; typecheck matrix TS 6.0/7.0/7.1-beta in CI).
2. **`@friday-friday/core`** ✅ (PR #11, issue #3 closed; sync surface per RFC-0001 §1–§4 incl. trySync boundary triage; 97 tests incl. fast-check laws + wire contracts; 255 B fixture / 876 B full core vs 600 B / 3 kB budgets; TS 6/7/7.1 matrix green. Known TS 7.0.2 quirks documented inline: order-dependent data-first matchTag inference in root tsc; const type-param union mangling on all().)
2a. **`@friday-friday/core` `/async`** ✅ (PR #12, issue #4 closed; async duals, allAsync input-order selection, mapConcurrent bounded concurrency, retry/timeout/tryAsync with signal forwarding; 141 tests; 258 B / 874 B / 1.19 kB vs 600 B / 3 kB / 3 kB budgets; TS matrix green. Signal-handling errata documented in RFC-0001 §4 + docs/decisions/2026-11-16-async-signal-handling.md.)
3. **`@friday-friday/schema`** — `parse parseAsync toFieldErrors toFormErrors branded toJsonSchema` over `@standard-schema/spec` 1.1 (types only).
4. **`@friday-friday/next`** — implemented on feat/next (PR #15, issue #7): server entry + server-only stub + /client boundary; unit-level sentinel-escape proofs (real-app e2e lands with examples/next-app #9). Base moduleResolution switched to bundler (next@16.4.6 subpaths unresolvable under NodeNext - empty exports map).
5. **`tooling/eslint-plugin`** — `must-use-result`, `no-try-around-redirect`, `no-instanceof-tagged-error` (per ADR-0003 outcome).
6. **`examples/next-app`** — REMAINING (issue #9, unblocked). Implementation notes for the next session/agent:
   - Scaffold with create-next-app@16.4 (App Router, TS), add @friday-friday/{core,schema,next} workspace deps.
   - One feature (profile update): server action via next.action + useActionState ({ ok: null } idle), redirect-after-save thrown OUTSIDE the action catch (sentinel proof), ValidationFailure -> toFieldErrors field errors, toResponse route handler with problem+json, orNotFound loader.
   - The AC proof "redirect survives try/catch" has unit-level coverage in packages/next/test/next.test.ts (sentinel escapes adapter triage unmapped); the example proves it live in a running app.
   - next@16.4.6 note: empty exports map -> plain-Node dist smokes impossible; run everything via the dev server.
   - create-next-app may try to init a git repo — use --disable-git or strip the nested .git; examples/* is covered by the workspace glob.

### Phase 2 — Data layer: `query`, `better-auth`, `http`, `otel`
`toQueryFn` (throw E, `Ok(undefined)`→null, signal), `resultQueryOptions`, `retryUnless`; `authCall/fromAuthTuple/requireSession/requireRole/beforeDbHook` via `isAPIError`; `fetchResult` with schema decode + problem+json reconstruction; `traced` span helpers.

### Phase 3 — Servers: `hono`, `trpc`
`respond` (status-literal unions), `problem` (RFC 9457 per RFC-0001 §6), `sv`, `onErrorHandler` (test HTTPException header loss — report marks it U); tRPC dual channel + Standard-Schema-based `errorFormatter` + `fromTRPC`. TS2589 budget fixtures.

### Phase 4 — `tanstack-start` (last; churn risk)
`resultServerFn` (validate inside handler; #6428 workaround), loader sentinels, Form mappers (structural checks only), Store `useSelector` only. Re-check #6428 before starting; drop workaround if fixed.

### Phase 5 — Extras: `effect`, `db`, `env`, codemods, oRPC recipe, `llms.txt` + per-package SKILL.md/AGENTS docs

## Guardrails (all phases)

- Locked decisions = IDEA.md §4; changes go through `docs/decisions/` note first.
- Every trap-absorbing behavior cites the research doc section in commit/PR/ADR.
- Unverified claims keep a `U` marker until checked against primary sources.
- Peer lower bounds = oldest version in the CI matrix; conservative ranges.
- Public repo: no secrets; no npm publish; 0.x until MVP runs a quarter in Eric's apps.
