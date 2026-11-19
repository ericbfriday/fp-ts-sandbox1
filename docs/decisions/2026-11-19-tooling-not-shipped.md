# 2026-11-19 — Open: do `tooling/eslint-plugin` and `tooling/codemods` ship? (#65, parent #51)

**Status: open. Eric decides.** Until then neither ships: `@friday-friday/eslint-plugin` is
`private: true`, and `tooling/codemods` has no package.json, so nothing can pack it. The publish
gate (`pnpm run pack:check`, `tooling/gates/src/publish-gate.ts`) packs only `packages/*` and lists
both under `notShipped`; `tooling/gates` fails if a tooling directory is missing from that list or
has a package.json that isn't private. No IDEA §4 decision changes. IDEA §8 asks for the three
lint rules, but not for publishing them.

## What shipping would take

**eslint-plugin** (today it only runs in this repo, from source):

- A build (tsdown, as in `packages/*`) and `exports` that point at `dist`, plus `files: ["dist"]`.
- Runtime deps out of devDependencies: `@typescript-eslint/utils` as a dependency; `eslint`,
  `typescript-eslint` and `typescript` as peers with tested ranges. The plugin pins its own
  TypeScript `~6.0` today while the repo runs 7.0, so the `typescript` peer range is a real
  decision (`U`: which TypeScript majors typescript-eslint 8.x supports when this is decided).
- Move it under `packages/`, or teach the gate a second directory, so the publish gate covers it.
  It already has `repository`.

**codemods** (one script, `neverthrow-to-core.mjs`):

- Settle #44 item 3 (codemod scope) first. On a realistic file it emits code that doesn't typecheck,
  and it raises no REVIEW flags.
- Then a package.json with a `bin`, `private` removed, `repository`, and a place in the gate.

## Options

1. Ship neither (status quo): the rules and the codemod stay repo-internal.
2. Ship the eslint-plugin only, after the work above. The codemod waits for #44 item 3.
3. Ship both.
