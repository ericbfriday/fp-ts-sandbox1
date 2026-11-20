# Handoff: fp-ts-sandbox1, after the 2026-11-18/19 architecture reviews

Repo: https://github.com/ericbfriday/fp-ts-sandbox1 (main @ `49c40c6`, CI green). A functional-light TypeScript Result library suite: a pnpm monorepo with 13 `@friday-friday/*` packages, Node 24, TypeScript 6.0 / 7.0 / 7.1-beta matrix.

## Where things stand

- **Both architecture reviews are implemented.** Every ticket under spec [#30](https://github.com/ericbfriday/fp-ts-sandbox1/issues/30) and spec [#51](https://github.com/ericbfriday/fp-ts-sandbox1/issues/51) is merged, except #65.
- **Last open PR:** [#104](https://github.com/ericbfriday/fp-ts-sandbox1/pull/104), the pack-level publish gate for #65. It is green and conflict-free, waiting for Eric to merge. Once it merges:
  - close #65 if it doesn't auto-close;
  - close spec #51, whose only open child is #65;
  - close spec #30 once #44 is settled, since #44 is its only open child.
- **The #66 grill session is finished.** See [ADR-0005](https://github.com/ericbfriday/fp-ts-sandbox1/blob/main/docs/adr/0005-core-owns-the-fixed-vocabulary.md), `GLOSSARY.md`, and the [#66 summary](https://github.com/ericbfriday/fp-ts-sandbox1/issues/66). That covers the fixed vocabulary, optional-only props enforced in `taggedError`'s types, and infrastructure tags crossing the wire as tag + status only.
- **Other decisions now on main:**
  - ADR-0006: suite packages are peer dependencies. While the suite is 0.x, core and the adapters release together.
  - ADR-0002 (updated): source-condition loading, gated by `pnpm run smoke:source`.
  - Adapter size budgets measure each adapter's own code, with core and schema ignored (PR #82; see CONTRIBUTING).

## What the next session is for: Eric's open decisions on [#44](https://github.com/ericbfriday/fp-ts-sandbox1/issues/44)

Read #44's body and comments first. Items 1, 2 and 6 are decided and done. Still open:

| # | Decision | Notes |
|---|---|---|
| 3 | Codemod scope | Today it produces output that doesn't typecheck. See #44 for options. |
| 4 | tRPC `.output()` layering vs `resultMiddleware` | trpc was reworked in #38/#57/#64; re-read `packages/trpc/src` before asking. |
| 5 | Peer ranges wider than tested | The CI tRPC 11.0.0 floor job (#57) is a model for per-peer floor jobs. |
| 7 | `must-use-result` vs bare `Promise<Result>` / floating promises | The rule was rewritten in #54; check current coverage first. |
| 8 | Do eslint-plugin and the codemod ship? | Added by #65. Options are in `docs/decisions/2026-11-19-tooling-not-shipped.md` (status: open). Depends on #3. |

Suggested flow: a grill session over these items (#3 and #8 together). For each answer, record it on #44, then turn it into tickets.

## Known follow-ups (not filed)

- **db:** a Prisma 6 model query cut off by 57P01 throws `PrismaClientUnknownRequestError`, whose SQLSTATE appears only in debug text (found in #99/PR #100). db is at 995 B of its 1 kB budget, so the next db change needs a budget decision.
- **`/wire`:** at 1543 B of its 1.6 kB budget.
- **ValidationFailure gap:** `taggedError("ValidationFailure")()` with no type argument still compiles, because TypeScript doesn't check a default against its constraint. Documented in core source and the plan.
- **Pass-throughs kept by #64:** tanstack-start's `toFormErrors`/`ValidationFailure` re-exports and trpc's one-line `sanitize`. They could be deleted under the "adapters export only glue" decision if Eric wants.
- **Type budget:** re-measure the TS 7.1 ceiling (`tooling/type-budget/budget.json`) when 7.1 stable ships; it was recorded on the beta.

## Working conventions that bit us (not written down elsewhere)

- **GitHub GraphQL was blocked** in the 2026-11-18 environment. `gh pr create` and `gh issue view` failed, so use `gh api` REST throughout. Sub-issues: `POST /issues/{n}/sub_issues`. Blocking: `POST /issues/{n}/dependencies/blocked_by`.
- **Never `git stash`.** The stash is shared across worktrees, and parallel agents' stashes got swapped. Commit work in progress instead.
- **Run `pnpm run build` before `pnpm run lint`.** oxlint's import rule reads each package's `dist`, and a stale dist gives false "not found" errors.
- **Never rewrite history on PR branches.** Merge `origin/main` in, with no rebase and no force-push.
- **Test open PRs together before merging.** Two PRs that each pass alone broke main when combined: #79 + #81 (a renamed smoke identifier) and #79 + #80 (a size budget). Merge them in a scratch worktree and run `pnpm run ci` there.
- **Parallel adapter PRs conflict in shared doc lines.** They collide in `README.md`, `llms.txt` and `docs/plan/IMPLEMENTATION_PLAN.md`, where each package has its own row and the rows sit next to each other. Resolve with a 3-way, per-line merge: take the side that differs from the base.
- **Under machine load, the first RuleTester case in `tooling/eslint-plugin/test/rules.test.ts` can time out.** It builds a TS program. Rerun it alone before treating it as a failure.
- **Eric merges every PR himself.** Agents open PRs and get CI green; nobody else merges. Use squash merges, with commit trailers per the session attribution.
- **Before handing a ticket to an agent,** give it AGENTS.md, CONTRIBUTING.md, IDEA §4, RFC-0001, the ADRs, and TDD through the public interface (failing test first). Mark unverified claims `U`, and keep `pnpm run ci` fully green with no silently raised budgets.

## Suggested skills

- `grill-with-docs` (mattpocock `engineering`): for the #44 decisions; record answers in GLOSSARY/ADRs.
- `to-tickets`: to turn each decision into issues.
- `tdd` and `codebase-design`: for implementation agents.
- `code-review`: for reviewing agent PRs before Eric merges.
- `improve-codebase-architecture`: only if Eric asks for a third review pass.

The Matt Pocock skills were cloned from GitHub into the workspace (`ext/mattpocock-skills/skills/engineering/*`). A fresh session needs to clone them again.
