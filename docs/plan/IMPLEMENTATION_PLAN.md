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

## Delegation model (as actually practiced)

| Workload | Executor | Notes |
|---|---|---|
| Implementation slices (core, /async, /gen, schema, next, lint rules) | **Hermes directly** | Claude Code hit the Pro subscription 5-hour wall repeatedly (resets every 5h); Hermes executed against the same gates |
| Two-axis review (standards + spec) | Hermes subagents | Every PR; caught real gaps each time (see PR review comments) |
| CI + merge to main | Hermes | 6/6 checks per PR; merge only after review findings resolved |

Claude Code remains available for future slices when quota allows (verified: 2.1.317 on the Pro subscription, `fable`/`opus`/`sonnet` aliases work, print-mode `-p` orchestration, no tmux on this host).

Rules: children read repo docs (IDEA.md, RFC, ADRs) — prompts stay lean; each slice = one feature branch → PR → CI → two-axis review → merge to main; no npm publishing, ever, without Eric.

## Deferred & accepted limitations (authoritative register)

Everything consciously postponed or accepted, with where it lives. Nothing else is silently deferred.

| Item | Where documented | When it lands |
|---|---|---|
| `examples/next-app` (issue #9, open) | Phase 1 step 6 notes (above) | Next session / CC after quota reset |
| Type-instantiation budget fixtures (`tsc --extendedDiagnostics`) | ADR-0004 | Phase 3 close — REQUIRED before the phase lands (raised in hono review); budget = fail CI on >20% instantiation regression, one fixture per server adapter |
| `no-instanceof-tagged-error`: MemberExpression RHS (e.g. `Errors.NotFound`) unflagged | PR #16 review (spec note) | v1 accepted; revisit on demand |
| `toResponse` problem `title` = raw `_tag`, not a human title | PR #15 review (judgement) | v1 accepted; RFC §6 errata candidate |
| Problem-body props are denylist (all JSON-safe minus `_tag`/`message`/`cause`), not RFC allowlist wording | PR #15 review (judgement) | Operative rule (cause + non-JSON-safe dropped) met and tested |
| `mapConcurrent` runs to completion on early `Err` (no in-flight abort) | async.ts doc | v1 choice |
| `retry` abort mid-retry returns the LAST Err (or Panic if nothing settled) | async.ts module doc | Deliberate choice |
| Pure `/async` duals take no `{ signal }` (closure-bound instead) | RFC-0001 §4 errata + decisions note | Errata accepted |
| Multi-step `gen` bodies need a generator return-type annotation (TS 7.0.2 Y-widening) | gen.ts header + gen.test-d.ts | Re-check at TS 7.1 stable (24 Nov 2026) |
| TS 7.0.2 root-tsc matchTag order-dependence; const type-param union mangling in `all()` | core src comments + issue #3 | Re-check at TS 7.1 stable |
| `@friday-friday/next`: no plain-Node dist smoke (next@16.4.6 empty exports map) | ADR-0004 + PR #15 | Runtime covered by vitest + examples/next-app (#9) |
| next adapter `tryAsync` takes no `{ signal }` (matches report §5.1 snippet exactly) | PR #15 review (judgement) | Core tryAsync remains the signal-capable path |
| `orForbidden` has no dedicated runtime test (forbidden() is mocked; loader AC is existence) | PR #15 review (judgement) | Fold into a future next-adapter PR |
| Phase 5 extras: `effect`, `db`, `env`, codemods, oRPC recipe, `llms.txt` + per-package SKILL.md | Phase 5 (below) | After MVP exit criteria |
| Examples runtime matrix (Bun/Deno/wrangler) | ADR-0004 | Later-phase CI job |
| Releases/Changesets/npm publish | ADR-0001 | Deferred until 0.x packages run a quarter in Eric's apps |
| ~~`AGENTS.md` repo guide~~ RESOLVED — created 2026-11-16 evening with Eric’s explicit authorization (repo root; living doc, update with conventions as they land) | repo root | done |

## Phases

### Phase 0 — Spec & decisions ✅ (PR #10)
- [x] ADR-0001 pnpm workspaces (no Nx in sandbox)
- [x] ADR-0002 tsdown ESM-only (verification gate PASSED in Phase-1 scaffold)
- [x] ADR-0003 linter strategy — Accepted with POC evidence (see below)
- [x] ADR-0004 Vitest + fast-check + size-limit + TS matrix + Actions CI
- [x] RFC-0001 core spec (Result shape, error taxonomy, wire envelope, RFC 9457 mapping)
- [x] Version/issue verification table (above)
- [x] Linter POC → **ADR-0003 Accepted** (PR #10): type-aware Oxlint works on Windows via oxlint-tsgolint; the 3 custom rules can't be Oxlint-native (no type-aware JS plugins) → local ESLint plugin pinned to `typescript ~6.0.3` (typescript-eslint peers `<6.1.0`); re-test at TS 7.1 stable.

### Phase 1 — MVP: `core` + `schema` + `next` + lint rules
Exit criteria (from report §9): size budgets green, TS 6/7/7.1 matrix green, `examples/next-app` runs one feature on Result, redirects survive try/catch.

1. **Scaffold** ✅ (PR #10, issue #2 closed; CI 6/6 green; tsdown gate PASSED; tsconfig.base strict+isolatedDeclarations+erasableSyntaxOnly; Vitest/--typecheck + fast-check + size-limit wired; `.size-limit.json` 600 B/3 kB; typecheck matrix TS 6.0/7.0/7.1-beta in CI).
2. **`@friday-friday/core`** ✅ (PR #11, issue #3 closed; sync surface per RFC-0001 §1–§4 incl. trySync boundary triage; 97 tests incl. fast-check laws + wire contracts; TS matrix green. Known TS 7.0.2 quirks documented inline: order-dependent data-first matchTag inference in root tsc; const type-param union mangling on all().)
2a. **`@friday-friday/core` `/async`** ✅ (PR #12, issue #4 closed; async duals, allAsync input-order selection, mapConcurrent bounded concurrency, retry/timeout/tryAsync with signal forwarding; signal-handling errata documented in RFC-0001 §4 + docs/decisions/2026-11-16-async-signal-handling.md.)
2b. **`@friday-friday/core` `/gen`** ✅ (PR #13, issue #5 closed; opt-in do-notation, one-shot `$()` wrapper, envelope identity preserved; documented constraint: multi-step bodies need a generator return-type annotation under TS 7.0.2.)
3. **`@friday-friday/schema`** ✅ (PR #14, issue #6 closed; parse/parseAsync, path normalization with `[symbol]` notes, toFieldErrors/toFormErrors, phantom branded(), toJsonSchema wrapped as Err(Unsupported); zod + valibot + arktype dev-only fixtures prove no vendor hard dep; 834 B of 2 kB.)
4. **`@friday-friday/next`** ✅ (PR #15, issue #7 closed; server entry + throwing stub + /client resultBoundary; triage delegated to core with nextRethrow pre-bound; sentinel-escape integration proofs at unit level — real-app e2e lands with #9. Base moduleResolution switched to bundler: next@16.4.6 ships an EMPTY exports map, NodeNext cannot resolve next/* subpaths — recorded in ADR-0004; plain-Node dist smoke impossible for this package.)
5. **`tooling/eslint-plugin`** ✅ (PR #16, issue #8 closed; must-use-result / no-try-around-redirect / no-instanceof-tagged-error implemented type-aware, WIRED into the shared eslint.config.js — the lint gate now enforces them repo-wide; no-try-around-redirect honors the unstable_rethrow catch-handler exemption; 21 RuleTester cases wired into vitest.)
6. **`examples/next-app`** — REMAINING (issue #9, unblocked). Implementation notes for the next session/agent:
   - Scaffold with create-next-app@16.4 (App Router, TS), add @friday-friday/{core,schema,next} workspace deps.
   - One feature (profile update): server action via next.action + useActionState ({ ok: null } idle), redirect-after-save thrown OUTSIDE the action catch (sentinel proof), ValidationFailure -> toFieldErrors field errors, toResponse route handler with problem+json, orNotFound loader.
   - The AC proof "redirect survives try/catch" has unit-level coverage in packages/next/test/next.test.ts (sentinel escapes adapter triage unmapped); the example proves it live in a running app.
   - next@16.4.6 note: empty exports map -> plain-Node dist smokes impossible; run everything via the dev server.
   - create-next-app may try to init a git repo — use --disable-git or strip the nested .git; examples/* is covered by the workspace glob.

### Phase 2 — Data layer: `query`, `better-auth`, `http`, `otel`
- **`@friday-friday/query`** ✅ (PR #18, merged; toQueryFn throws plain tagged E (query.error === E), Ok(undefined) → null, retryUnless + resultQueryOptions; REAL QueryClient.fetchQuery integration tests prove error identity + retry counts; TS 7.1-beta conditional-type quirk worked around via shared QueryFnReturn alias)
- **`@friday-friday/better-auth`** ✅ (PR #19, merged; authCall/fromAuthTuple/requireSession/requireRole/beforeDbHook; one AuthError vocabulary Unauthenticated|Forbidden|AuthApiError{status,code}; structural isAPIError (NOT instanceof — duplicate better-call copies); defects rethrow as Panic via core tryAsync triage; beforeDbHook emits the VENDORED contract false|{data}|void (runner checks === false and 'data' in result only — no abort field; verified in better-auth 1.7.25 sources); 970 B vs 2 kB)
- **`@friday-friday/http`** ✅ (PR #20, merged; fetchResult{schema,signal,timeoutMs,retries} with Err channels HttpError{status,problem?}|NetworkError|Timeout|ValidationFailure; RFC 9457 problem+json parsed, `tag` extension + reconstruct() proved lossless in tests against next toResponse's exact shape; retries cover transport only, never status failures; 1.05 kB vs 2 kB)
`toQueryFn` (throw E, `Ok(undefined)`→null, signal), `resultQueryOptions`, `retryUnless`; `authCall/fromAuthTuple/requireSession/requireRole/beforeDbHook` via `isAPIError`; `fetchResult` with schema decode + problem+json reconstruction; `traced` span helpers.

### Phase 3 — Servers: `hono`, `trpc`
- **`@friday-friday/hono`** 🔄 (PR #22, open, CI 6/6; respond + StatusMap literal statuses with hc inference proven in type tests incl. per-status res.json() narrowing, RFC 9457 problem() with reconstruct round-trip via in-repo fixture — adapters never import each other, sv on hono validator + ~standard: report's sValidator does not exist in any hono version (verified 4.13.18/19 + 5.0.0-rc.1), onErrorHandler with HTTPException header passthrough (report's U claim exercised); TS2589 guidance reproduced live in tests; peer `^4.13.18 || ^5` documented — 4.13.19 blocked by pnpm's CI-enforced supply-chain minimumReleaseAge, 5.0.0-rc onError changes NOT covered (needs an rc fixture before range extension); 929 B)
- `trpc` dual channel + Standard-Schema-based `errorFormatter` + `fromTRPC`. TS2589 budget fixtures.

### Phase 4 — `tanstack-start` (last; churn risk)
`resultServerFn` (validate inside handler; #6428 workaround), loader sentinels, Form mappers (structural checks only), Store `useSelector` only. Re-check #6428 before starting; drop workaround if fixed.

### Phase 5 — Extras: `effect`, `db`, `env`, codemods, oRPC recipe, `llms.txt` + per-package SKILL.md/AGENTS docs

## Guardrails (all phases)

- Locked decisions = IDEA.md §4; changes go through `docs/decisions/` note first.
- Every trap-absorbing behavior cites the research doc section in commit/PR/ADR.
- Unverified claims keep a `U` marker until checked against primary sources.
- Peer lower bounds = oldest version in the CI matrix; conservative ranges.
- Public repo: no secrets; no npm publish; 0.x until MVP runs a quarter in Eric's apps.
