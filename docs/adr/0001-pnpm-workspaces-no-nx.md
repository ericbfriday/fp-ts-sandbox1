# ADR 0001 — Plain pnpm workspaces, no Nx in the sandbox

Status: Accepted · Date: 2026-11-16

## Context

IDEA.md §10.3: Nx vs plain pnpm workspaces. Eric's day job is an Nx/Next.js monorepo and the design must drop into one cleanly, but this repo is a proving sandbox. The Design Report (§6) assumes pnpm workspaces "with Nx or Changesets for releases".

## Decision

Plain **pnpm workspaces** (`pnpm-workspace.yaml` with `packages/*`, `tooling/*`, `examples/*`). No Nx, no Changesets yet — releases are out of scope until 0.x packages are real.

## Consequences

- Layout mirrors Nx conventions (`packages/*` publishable, `tooling/*` internal, `examples/*` integration tests) so an Nx lift later is mechanical.
- Task orchestration is plain pnpm `-r --filter` scripts + a root `ci` script.
