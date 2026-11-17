# CONTRIBUTING.md

Thanks for contributing to `@friday-friday/*`. This repo has one rule above all others: **the adapters must be correct at every framework boundary** — read the philosophy in `DEVELOPER.md` first.

## How decisions get made

- Locked design decisions live in `IDEA.md` §4 (plain-data Results, tagged errors, thrown defects, no HKTs, no Option, Standard Schema only, signals flow down).
- Architecture decisions are recorded as ADRs in `docs/adr/` (one short file each: context → decision → consequences).
- Amendments to an accepted decision get a dated note in `docs/decisions/` — never a silent edit. See `2026-11-16-async-signal-handling.md` for the format.
- Trap-absorbing behavior must cite the research doc section it implements (commit message, PR body or ADR).

## Pull-request flow

1. Branch from `main`: `feat/<area>` or `fix/<area>`.
2. One package or concern per PR. Land it with tests — runtime behavior, `*.test-d.ts` type tests, property laws where math applies, wire contracts (`JSON` + `structuredClone` round-trip) for every public output.
3. Run `pnpm ci` (lint + typecheck matrix + test + size) locally. CI runs the same thing plus a TS 6.0 → 7.0 → 7.1-beta matrix.
4. PR description: what, which spec/issue section is normative, size numbers for new dist output, deviations called out explicitly.
5. Reviews are two-axis (standards + spec) and findings are fixed before merge — expect the spec reviewer to quote your issue's acceptance criteria back at you.
6. Merge to `main` by merge commit (history stays linear per slice); the issue closes with an evidence comment.

## Code standards

- ESM-only, TypeScript 7, **erasable syntax only** (`no enum`, `namespace`, parameter properties). `isolatedDeclarations`-clean: explicit types on every export.
- Plain data over classes. Tagged errors via the `taggedError` factory with structural `.is()` — never `instanceof` (the lint rule enforces it).
- Dual combinators dispatch on `arguments.length`; separate named exports with `/*#__PURE__*/` so unused ones tree-shake.
- Error unions grow by `|` only; `E` defaults to `never`.
- Every async helper that can cancel takes `{ signal }` and forwards it into user callbacks. Abort semantics are documented per function — see `packages/core/src/async.ts`.
- Boundary sanitation is non-negotiable: `cause` and non-JSON-safe props never cross a wire boundary.
- Framework vendors are peers (conservative ranges, lower bound = oldest tested version); vendors in tests are devDeps only.
- Size budgets are hard: core fixture ≤ 600 B, full core ≤ 3 kB, adapters ≤ 2 kB (`.size-limit.json`).
- When a cast is unavoidable (AST universes, phantom brands, wire decoding), guard it structurally and leave a scoped disable comment **with a reason**. Untouched assertions fail review.

## Issue triage

- `needs-triage` → maintainer evaluates; `needs-info` → waiting on reporter; `ready-for-agent` → fully specified, safe for an unattended agent; `ready-for-human` → needs a human; `wontfix` → closed with rationale.
- Agents: read `docs/agents/issue-tracker.md` for the GitHub workflow and `docs/plan/IMPLEMENTATION_PLAN.md` for what to pick up next.

## What we do NOT accept

- Vendor hard-dependencies in runtime code (Standard Schema types-only, fixtures in devDeps).
- HKT/typeclass machinery, an Option type, collections/pattern-matching re-implementations (defer to Remeda/es-toolkit/ts-pattern), effect runtimes in the core.
- Third-party neverthrow/Result lint plugins (supply-chain incidents — write rules in `tooling/eslint-plugin` instead).
- Publishing to npm from CI or without Eric's explicit go-ahead; secrets of any kind (public repo).
