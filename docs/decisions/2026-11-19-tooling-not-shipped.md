# 2026-11-19 — Do `tooling/eslint-plugin` and `tooling/codemods` ship? (#65, parent #51)

**Status: decided (Eric, #44 decision 8): option 2.** The eslint-plugin ships with the suite's first
release. The codemod stays internal. Nothing is published until Eric says so (AGENTS.md).

## What was done

**eslint-plugin** (#106):

- A tsdown build to `dist`. `exports` keeps the `@friday-friday/source` condition for in-repo use
  (vitest, the repo's `eslint.config.js` imports `src` directly), and `publishConfig.exports` drops
  it, as in `packages/*`. `files: ["dist"]`, no `private`.
- Dependencies: `src` imports `@typescript-eslint/utils`, `eslint` and `typescript` as **types
  only**, so the built JS imports nothing and the `.d.ts` names only `eslint`. Hence:
  - peers `eslint ^10.15.0` and `typescript-eslint ^8.72.2`. Their lower bounds are the versions
    CI runs (the lockfile), so the regular test job is the floor. Without typescript-eslint's
    parser and type information the rules can't see types and report nothing;
  - **no `typescript` peer.** The rules use the `ts.Program` that typescript-eslint's parser
    services hand them and never import `typescript`, so typescript-eslint's own `typescript` peer
    range is what governs. (In this repo that's TypeScript ~6.0, because typescript-eslint 8.x
    needs the classic compiler API; the repo itself builds on 7.0, see `eslint.config.js`.)
  - `@typescript-eslint/utils` stays a devDependency (types only, not in the artifact).
- It stays in `tooling/`. The publish gate packs `packages/*` plus `shippedTooling`
  (`tooling/gates/src/publish-gate.ts`). The root `build` and `smoke` scripts include it, and
  `tooling/gates` checks all of that. It has no size budget: it isn't browser code.

**codemods** (#107): `neverthrow-imports.mjs` is an honest import rewriter that flags every method
call for REVIEW (#44 decision 3). It has no package.json, and `notShipped` lists it.

## Options that were on the table

1. Ship neither (status quo then).
2. **Ship the eslint-plugin only. The codemod waits for #44 item 3** (chosen; item 3 then kept it
   internal).
3. Ship both.
