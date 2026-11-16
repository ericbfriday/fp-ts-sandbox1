# ADR 0003 — Linter strategy: Oxlint base + local ESLint plugin for the three custom type-aware rules

Status: Proposed → resolve via POC in scaffold task · Date: 2026-11-16

## Context

IDEA.md §2/§10.2: use "the same linter Effect uses"; evidence points to Oxlint type-aware via oxlint-tsgolint. IDEA.md also notes custom type-aware **JS plugins are not yet supported** in Oxlint, and the three custom rules (`must-use-result`, `no-try-around-redirect`, `no-instanceof-tagged-error`) are type-aware or AST-semantic. IDEA.md §8 forbids third-party neverthrow lint plugins (supply-chain incidents).

## Decision (pending POC)

1. Base lint: **Oxlint** (already in root devDeps, `.oxlintrc.json`), config style decided by the POC (`.oxlintrc.json` vs `oxlint.config.ts`).
2. The three custom rules live in **our own** `tooling/eslint-plugin` (typescript-eslint flat config, type-aware) — written locally, never pulled from third parties.
3. If the POC shows Oxlint (tsgolint) can host these rules natively/by config on Windows, migrate them and drop ESLint; record the outcome here and in AGENTS.md.

## Notes

- `must-use-result` flags discarded `Result`/`AsyncResult` expressions (TS does not force consumption).
- `no-try-around-redirect` flags `redirect()`/`notFound()` inside `try` without a preceding rethrow.
- `no-instanceof-tagged-error` flags `instanceof` against tagged-error factories (use the structural `.is()`).
