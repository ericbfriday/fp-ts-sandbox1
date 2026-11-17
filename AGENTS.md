# AGENTS.md — fp-ts-sandbox1

Project brief: see **`IDEA.md`** (read it first). The authoritative design source is `docs/Functional-Light TypeScript Library Suite ... Design Report (November 2026).md`; `IDEA.md` §3 ranks the research docs and lists known conflicts (Design Report wins). The **living plan** — phase status, verified evidence baseline, deferred-work register — is `docs/plan/IMPLEMENTATION_PLAN.md`. Commands live in `README.md`.

## Commands

- `pnpm run check` — typecheck (`tsc --noEmit`), TS 7 locally; CI also runs TS 6.0 / 7.1-beta via npm aliases
- `pnpm run lint` — oxlint (type-aware) + local ESLint rules (repo-wide, enforced) + dprint check
- `pnpm run lint-fix` — oxlint --fix + dprint fmt
- `pnpm test` — Vitest runtime + type tests; `pnpm test:types` for type-only
- `pnpm run build` / `pnpm run size` / `pnpm run smoke` — build, size budgets, dist smokes
- `pnpm run ci` — everything CI runs, locally

## Conventions

- ESM-only, TypeScript 7, **erasable syntax only** (no `enum`, `namespace`, parameter properties); `isolatedDeclarations`-clean — explicit return types on every export.
- **Module resolution is `bundler`** (not NodeNext): next@16.4.6 ships an empty exports map, so NodeNext cannot resolve `next/*` subpaths. See ADR-0004.
- Small PR-sized steps: one package or concern at a time, each landing with its own tests, feature branch → PR → CI → review → merge to main.
- Source of truth for locked design decisions is `IDEA.md` §4. To change one, stop and write a note in `docs/decisions/` first.
- Cite the research doc section in commit messages / ADRs when implementing a trap-absorbing behavior.
- Mark unverified claims with `U` in docs and comments; verify before removing the mark.
- Never publish to npm from this repo without Eric's explicit say-so. Public repo: never commit secrets.
- Scope names in code: `@friday-friday/*` (not the report's `@fl/*` placeholders).
- Lint directives: this repo runs BOTH oxlint and ESLint. Use `// oxlint-disable-next-line <rule>` for oxlint rules and `// eslint-disable-next-line <rule>` for ESLint rules — each tool errors on the other's unknown rule ids.

## Package map (implemented)

- `packages/core` — `@friday-friday/core` (+ `/async`, `/gen` subpaths)
- `packages/schema` — `@friday-friday/schema`
- `packages/next` — `@friday-friday/next` (react-server/default/client conditions)
- `tooling/eslint-plugin` — `@friday-friday/eslint-plugin`

## Agent skills

### Issue tracker

GitHub Issues on `ericbfriday/fp-ts-sandbox1` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
