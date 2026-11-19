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
| `examples/next-app` (issue #9) | DONE — PR #25 merged | closed 2026-11-17 |
| Type-instantiation budget fixtures (`tsc --extendedDiagnostics`) | ADR-0004, IDEA §8 | **Issue #61** (the "Phase 4 kickoff" target passed with no ticket). Needs per-TS-version baselines (6.0/7.0/7.1 counts differ; a single absolute budget would be flaky across the matrix); #61 decides per-version ceilings vs one 7.x job |
| `no-instanceof-tagged-error`: MemberExpression RHS (e.g. `Errors.NotFound`) unflagged | PR #16 review (spec note) | v1 accepted; revisit on demand |
| ~~`toResponse` problem `title` = raw `_tag`, not a human title~~ RESOLVED — `toResponse` now delegates to core `/wire` `toProblem` (`NotFound` → `Not Found`) | PR #15 review (judgement) | #39 |
| Problem-body props are denylist (all JSON-safe minus `_tag`/`message`/`cause`), not RFC allowlist wording | PR #15 review (judgement) | Core `/wire` supports `safeProps`; next's `toResponse` does not expose it yet (#39 kept its interface to status map + `onDefect`). Unmapped tags are masked as `InternalDefect`, which closes the leak class |
| `mapConcurrent` runs to completion on early `Err` (no in-flight abort) | async.ts doc | v1 choice |
| `retry` abort mid-retry returns the LAST Err (or Panic if nothing settled) | async.ts module doc | Deliberate choice |
| Pure `/async` duals take no `{ signal }` (closure-bound instead) | RFC-0001 §4 errata + decisions note | Errata accepted |
| Multi-step `gen` bodies need a generator return-type annotation (TS 7.0.2 Y-widening) | gen.ts header + gen.test-d.ts | Re-check at TS 7.1 stable (24 Nov 2026) |
| TS 7.0.2 root-tsc matchTag order-dependence; const type-param union mangling in `all()` | core src comments + issue #3 | Re-check at TS 7.1 stable |
| `@friday-friday/next`: no plain-Node dist smoke (next@16.4.6 empty exports map) | ADR-0004 + PR #15 | Runtime covered by vitest + examples/next-app (#9) |
| next adapter `tryAsync` takes no `{ signal }` (matches report §5.1 snippet exactly) | PR #15 review (judgement) | Core tryAsync remains the signal-capable path |
| ~~`orForbidden` has no dedicated runtime test~~ RESOLVED — loaders.test.ts runs it against the real `forbidden()` (#52); next.test.ts no longer mocks `next/navigation` (#39) | PR #15 review (judgement) | #52, #39 |
| Phase 5 extras: `effect`, `db`, `env`, codemods, oRPC recipe, `llms.txt` + per-package SKILL.md | Phase 5 (below) | After MVP exit criteria |
| `toMutationFn` in `@friday-friday/query` (IDEA §5 package map) | IDEA §5; not implemented | **Deferred, no ticket.** Mutations need no throw bridge the way `queryFn` does: a `mutationFn` may return the Result as data and the caller branches on `r.ok`. Revisit if a caller needs `mutation.error === E` (it would be `toQueryFn`'s Err-throws rule over `MutationFunction`) |
| Core `/interop` subpath (IDEA §5 package map) | IDEA §5; not implemented (core exports `.`, `/async`, `/gen` only) | **Deferred, no ticket.** Prior-art converters (better-result, unthrown, byethrow, neverthrow) stay out of core; the neverthrow migration is the codemod in `tooling/codemods`, Effect is `@friday-friday/effect`. Revisit on a concrete interop request |
| Examples runtime matrix (Bun/Deno/wrangler) | ADR-0004 | Later-phase CI job |
| Releases/Changesets/npm publish | ADR-0001 | Deferred until 0.x packages run a quarter in Eric's apps |
| Per-package AGENTS.md polish (root AGENTS.md is the living guide; per-package notes are pointers, added on demand) | docs/agents/ | On demand — root guide covers all conventions today |
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
2c. **`@friday-friday/core` `/wire`** ✅ (PR #50, issue #33; `sanitize`, `toProblem` (RFC 9457 body, tag→status defaults), `fromWire` (problem body or sanitized error → tagged error), `toDefect` (fixed `InternalDefect` envelope, cause → report only), `PROBLEM_CONTENT_TYPE`; rules in docs/decisions/2026-11-17-core-wire-subpath.md; adapters migrate in #37–#40; 1.39 kB vs 1.5 kB.)
2d. **Core defect triage** ✅ (PR #47, issue #31; one idempotent `toPanic(cause)` that every lane converts through, one contract test `packages/core/test/defects.test.ts`; `Panic` message is bounded and never prints thrown data, RFC-0001 §3.)
3. **`@friday-friday/schema`** ✅ (PR #14, issue #6 closed; parse/parseAsync, path normalization with `[symbol]` notes, toFieldErrors/toFormErrors, phantom branded(), toJsonSchema wrapped as Err(Unsupported); zod + valibot + arktype dev-only fixtures prove no vendor hard dep. **PR #45 (issue #32):** `toValidationFailure(issues)` is the one `ValidationFailure` producer (each issue projected to `{ message, path }`, idempotent); a vendor throw inside `validate` becomes `Panic`; 1 kB of 2 kB.)
4. **`@friday-friday/next`** ✅ (PR #15, issue #7 closed; server entry + throwing stub + /client resultBoundary; triage delegated to core with nextRethrow pre-bound; sentinel-escape integration proofs at unit level — real-app e2e lands with #9. Base moduleResolution switched to bundler: next@16.4.6 ships an EMPTY exports map, NodeNext cannot resolve next/* subpaths — recorded in ADR-0004; plain-Node dist smoke impossible for this package.)
5. **`tooling/eslint-plugin`** ✅ (PR #16, issue #8 closed; must-use-result / no-try-around-redirect / no-instanceof-tagged-error implemented type-aware, WIRED into the shared eslint.config.js — the lint gate now enforces them repo-wide; no-try-around-redirect honors the unstable_rethrow catch-handler exemption; 21 RuleTester cases wired into vitest.)
6. **`examples/next-app`** — DONE (PR #25 merged, issue #9 closed 2026-11-17). Profile update form on next@16.4: action() + ValidationFailure field errors as data, session guard -> Forbidden, redirect sentinel survives the triage (proven on the wire), orNotFound loader, toResponse problem+json route.
   - Scaffold with create-next-app@16.4 (App Router, TS), add @friday-friday/{core,schema,next} workspace deps.
   - One feature (profile update): server action via next.action + useActionState ({ ok: null } idle), redirect-after-save thrown OUTSIDE the action catch (sentinel proof), ValidationFailure -> toFieldErrors field errors, toResponse route handler with problem+json, orNotFound loader.
   - The AC proof "redirect survives try/catch" has unit-level coverage in packages/next/test/next.test.ts (sentinel escapes adapter triage unmapped); the example proves it live in a running app.
   - next@16.4.6 note: empty exports map -> plain-Node dist smokes impossible; run everything via the dev server.
   - create-next-app may try to init a git repo — use --disable-git or strip the nested .git; examples/* is covered by the workspace glob.

### Phase 2 — Data layer: `query`, `better-auth`, `http`, `otel`
- **`@friday-friday/query`** ✅ (PR #18, merged; toQueryFn throws plain tagged E (query.error === E), Ok(undefined) → null, retryUnless + resultQueryOptions; REAL QueryClient.fetchQuery integration tests prove error identity + retry counts; TS 7.1-beta conditional-type quirk worked around via shared QueryFnReturn alias. **PR #46 (issue #36) redesign:** `resultQueryOptions<T, E, TData, K>` is generic over query-core's `QueryObserverOptions`, so every TanStack option (`staleTime`, `enabled`, `select`, `retry`, `meta`, `throwOnError`, `as const` keys) passes through untouched; it returns a `DataTag`-ged `queryKey` so `getQueryData`/`getQueryState(...).error` infer T/E; E is inferred from the fetcher only (`NoInfer<E>` on options). `@tanstack/query-core ^5` peer now used for types. **PR #68 (issue #58):** `queryFn: skipToken` passes through (overload keeps `SkipToken` in the output so Suspense hooks reject it, as with TanStack's `queryOptions`); 325 B vs 1 kB)
- **`@friday-friday/better-auth`** ✅ (PR #19, merged; authCall/fromAuthTuple/requireSession/requireRole/beforeDbHook; one AuthError vocabulary Unauthenticated|Forbidden|AuthApiError{status,code}; structural isAPIError (NOT instanceof — duplicate better-call copies); defects rethrow as Panic via core tryAsync triage; beforeDbHook emits the VENDORED contract false|{data}|void (runner checks === false and 'data' in result only — no abort field; verified in better-auth 1.7.25 sources); 970 B vs 2 kB)
- **`@friday-friday/http`** ✅ (PR #20, merged; fetchResult{schema,signal,timeoutMs,retries} with Err channels HttpError{status,problem?}|NetworkError|Timeout|ValidationFailure; RFC 9457 problem+json parsed, `tag` extension + reconstruct() proved lossless in tests against next toResponse's exact shape; retries cover transport only, never status failures; 1.05 kB vs 2 kB)
- **`@friday-friday/otel`** ✅ (PR #21, merged; traced/tracedSync: Err -> span ERROR + `friday_friday.error.tag` attr (renamed from the report's `fl.error.tag` placeholder in issue #59, RFC-0001 §7) WITHOUT recordException (expected-vs-bug separation), defects recorded as exceptions and rethrown; span always ends; no-op-safe without an SDK; 468 B vs 2 kB)

**Phase 2 complete.**
`toQueryFn` (throw E, `Ok(undefined)`→null, signal), `resultQueryOptions`, `retryUnless`; `authCall/fromAuthTuple/requireSession/requireRole/beforeDbHook` via `isAPIError`; `fetchResult` with schema decode + problem+json reconstruction; `traced` span helpers.

### Phase 3 — Servers: `hono`, `trpc`
- **`@friday-friday/hono`** ✅ (PR #22, MERGED; respond + StatusMap literal statuses with hc inference proven in type tests incl. per-status res.json() narrowing, RFC 9457 problem() with reconstruct round-trip via in-repo fixture — adapters never import each other, sv on hono validator + ~standard: report's sValidator does not exist in any hono version (verified 4.13.18/19 + 5.0.0-rc.1), onErrorHandler with HTTPException header passthrough (report's U claim exercised); TS2589 guidance reproduced live in tests; peer `^4.10 || ^5.0.0-0` (package.json, per the baseline table) while tests run the exact devDep pin 4.13.18 — 4.13.19 blocked by pnpm's CI-enforced supply-chain minimumReleaseAge; 5.0.0-rc onError changes NOT covered by a fixture yet (see the peer-range note in `packages/hono/src/index.ts`); 929 B)
- **`@friday-friday/trpc`** ✅ (PR #23, MERGED; dual channel: resultMiddleware Err -> TRPCError with mapped code + cause, errorFormatter data.fl = sanitize(e) or ~standard issues (structural, no instanceof ZodError), resultProcedure data-channel opt-in, fromTRPC lossless reconstruction; 7 tests on a REAL router via the fetch adapter + httpBatchLink; 850 B)
`respond` (status-literal unions), `problem` (RFC 9457 per RFC-0001 §6), `sv`, `onErrorHandler` (test HTTPException header loss — report marks it U); tRPC dual channel + Standard-Schema-based `errorFormatter` + `fromTRPC`. TS2589 budget fixtures: not built in Phase 3, now issue #61 (see register).

### Phase 4 — `tanstack-start` (last; churn risk)
- **`@friday-friday/tanstack-start`** ✅ (PR #26, merged; resultHandler = the #6428 workaround — validation INSIDE the handler, Err(ValidationFailure) as structured data, domain errors as data, only defects throw as Panic; #6428 re-checked 2026-11-17, still OPEN — workaround stands; loaderResult maps NotFound->notFound() / Unauthenticated->redirect({to:"/login"}) sentinels THROWN unwrapped, other Err as Panic with lossless cause; toFormErrors passthrough; vendor-light (router-core peer ^1.169, devDep exact 1.171.39); 12 tests; size entry with peer ignore)
`resultServerFn` (validate inside handler; #6428 workaround), loader sentinels, Form mappers (structural checks only), Store `useSelector` only. Re-check #6428 before starting; drop workaround if fixed.

### Phase 5 — Extras: `effect`, `db`, `env`, codemods, oRPC recipe, `llms.txt` + per-package SKILL.md/AGENTS docs
- **`@friday-friday/db`** ✅ (PR #27, merged; mapPgError/mapPrismaError/mapDbError — structural code reads, zero vendor imports. **PR #48 (issue #35):** codes found on the error or up to 5 hops down `cause` (drizzle-orm's `DrizzleQueryError` maps); PG 23505 → Conflict{constraint}, 23503 → ForeignKeyViolation{constraint, column}, 23502 → NotNullViolation{column, constraint} (new tag); Prisma P2002 → Conflict{field, constraint}, P2003 → ForeignKeyViolation, P2025 → NotFound. Shapes captured from pg 8.23, postgres-js 4.1, drizzle-orm 0.45, Prisma 6.19 and 7.10 on PostgreSQL 16, so the P-code U is lifted; remaining U: Neon serverless shape, Prisma `meta.target` as a plain string. Props hold schema names only; driver `detail` rides on server-only `cause`; 852 B vs 1 kB)
- **`@friday-friday/env`** ✅ (PR #27, merged; parseEnv(schema, env?) over process.env/import.meta.env/fixtures — Err(ValidationFailure), no throw at import time; @t3-oss/env interop documented. **PR #49 (issue #34):** issue messages redact the offending variable's raw value (root issues redact all), the default source is `{}` without a global `process`, `""` counts as unset, strict boolean recipes replace `z.coerce.boolean()`, `ok`/`err` re-exports removed. **PR #67 (issue #56):** value redaction replaced: issue messages are built from the variable name only (`NAME is missing` / `NAME is invalid`, root `env is invalid`; path stops at the name), so derived echoes (trim, case change, JSON path) cannot leak; whitespace-only values count as unset too. Budget 1.1 kB (bundles core's `Panic` message, see CONTRIBUTING); 900 B vs 1.1 kB)
- **`@friday-friday/effect`** ✅ (PR #28, merged; #42 fix: fromExit — Fail -> Err, Die/Interrupt -> Panic via core `toPanic` (no double wrap); precedence Die > Interrupt > Fail is the bridge's own choice and NOT Effect's ordering — `Cause.squash` returns the first Fail ahead of a Die (pinned in a test); runResult — failures as data, signal forwarded via runPromiseExit, abort -> Panic(abort reason) like core /async; toEffect sync+async, a rejecting AsyncResult -> Effect.die (Effect.promise + flatMap; no ErrCarrier); only @stability-stable members of the `effect` root entry, gated by test/stability.test.ts; peer ^4.0.0, devDep exact 4.0.6 for the supply-chain window)
- **`llms.txt`** ✅ (root; LLM-consumable suite summary)
- **`docs/recipes/orpc.md`** ✅ (oRPC v2 pairing recipe: data-channel default, error-channel via sanitize/reconstruct, resultHandler reuse; first-class-adapter scope notes)
- **`tooling/codemods/neverthrow-to-core.mjs`** ✅ (mechanical import rewrite + 1:1 identifier map; unmappable APIs flagged for review — 3 tests)

## Guardrails (all phases)

- Locked decisions = IDEA.md §4; changes go through `docs/decisions/` note first.
- Every trap-absorbing behavior cites the research doc section in commit/PR/ADR.
- Unverified claims keep a `U` marker until checked against primary sources.
- Peer lower bounds = oldest version in the CI matrix; conservative ranges.
- Public repo: no secrets; no npm publish; 0.x until MVP runs a quarter in Eric's apps.
