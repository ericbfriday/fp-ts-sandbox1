# ADR 0003 — Linter strategy: Oxlint base + local ESLint plugin for the three custom type-aware rules

Status: Accepted (POC in scaffold task #2) · Date: 2026-11-16

## Context

IDEA.md §2/§10.2: use "the same linter Effect uses"; evidence points to Oxlint type-aware via oxlint-tsgolint. IDEA.md also notes custom type-aware **JS plugins are not yet supported** in Oxlint, and the three custom rules (`must-use-result`, `no-try-around-redirect`, `no-instanceof-tagged-error`) are type-aware or AST-semantic. IDEA.md §8 forbids third-party neverthrow lint plugins (supply-chain incidents).

## Decision

1. Base lint: **Oxlint, type-aware** (`oxlint-tsgolint`), configured in **`.oxlintrc.json`** with `"options": { "typeAware": true }`. `oxlint.config.ts` also loads, but JSON keeps the `$schema` autocomplete and needs no TS loader; switch only if we adopt Oxlint JS plugins.
2. The three custom rules live in **our own** `tooling/eslint-plugin` (typescript-eslint flat config, type-aware) — written locally, never pulled from third parties. ESLint runs only these rules; Oxlint owns everything else. Wired into `pnpm run lint` now; rules land in #8.
3. Revisit when Oxlint JS plugins gain type information: then migrate the rules and drop ESLint.

### POC evidence (2026-11-16, Windows 11 x64, Node 24.19.0)

- `oxlint 1.93.0` + `oxlint-tsgolint 7.0.2007` (`@oxlint-tsgolint/win32-x64`): `--type-aware`, and `options.typeAware` in `.oxlintrc.json`, both reported `typescript/no-floating-promises` on a probe file. Built-in type-aware rules work on Windows.
- Oxlint's JS-plugin docs state: "Not supported yet: Lint rules that rely on TypeScript type-awareness." `must-use-result` needs the checker, and tsgolint has no rule that can be configured to mean "a `Result` value was discarded". **So the three rules cannot be Oxlint-native → ESLint fallback required.**
- `typescript-eslint` 8.72/8.73 peers `typescript >=4.8.4 <6.1.0`, because TS 7 has no classic JS compiler API. `tooling/eslint-plugin` therefore pins its own `typescript ~6.0.3`, while the repo builds on TS 7. `@typescript-eslint/no-floating-promises` fired on the same probe through `projectService`, which proves the type-aware ESLint path on TS 6.0.
- Re-test when TS 7.1 ships `typescript/sync`/`typescript/async`, or when typescript-eslint supports TS 7.

## Notes

- `must-use-result` flags discarded `Result`/`AsyncResult` expressions (TS does not force consumption).
- `no-try-around-redirect` flags `redirect()`/`notFound()` inside `try` without a preceding rethrow.
- `no-instanceof-tagged-error` flags `instanceof` against tagged-error factories (use the structural `.is()`).
