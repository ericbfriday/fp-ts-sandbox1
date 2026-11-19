# 2026-11-19 — Peer ranges match a tested floor (#109, #44 decision 5)

**Status: decided (Eric, #44 decision 5).**

IDEA §4 requires that "each peer range's lower bound equals the oldest version in the CI matrix".
Only trpc had a floor job (#57). #109 adds one row per adapter to CI's `peer-floor` matrix (a
throwaway `pnpm add -D` of the floor, then `pnpm run check` and the package's tests). Every lower
bound was run locally on Node 24 the same way, and ranges whose floor failed were narrowed to the
lowest version that passes (bisected over published versions):

| package | was | floor tried | result | now |
|---|---|---|---|---|
| better-auth | `^1.6 \|\| ^1.7` | 1.6.0 | pass | `^1.6` (same set, one bound) |
| effect | `^4.0.0` | 4.0.0 | **fail**: 4.0.0–4.0.1 lack `@stability stable` on members the bridge uses (IDEA §4.10 gate) | `^4.0.2` |
| hono | `^4.10 \|\| ^5.0.0-0` | 4.10.0 | pass; the 5.x prerelease arm was never tested | `^4.10` |
| next / react | `>=16.3 <18` / `>=19.2` | 16.3.0 / 19.2.0 | pass | unchanged |
| otel | `^1` | 1.0.0 | **fail**: no `Attributes` export before 1.1 | `^1.1` |
| query | `^5` | 5.0.0 | **fail**: no `SkipToken`, one-arg `DataTag` | `^5.62` |
| tanstack-start | `^1.169` | 1.169.0 | pass | unchanged |
| trpc | `^11` (+ unused `@trpc/client ^11`) | 11.0.0 | pass | `@trpc/server ^11` only |

The otel floor also needed a test-only fix: the test's fake span typed its attributes with the API's
`Attributes`, whose value type changed in 1.10; it now uses its own record type.

**Locked-decision touch:** IDEA §4.10 said `effect ^4.0`. It now says `^4.0.2`. This narrows the
range to what the §4.10 stability gate accepts and doesn't change the decision.

**tanstack-start keeps `@tanstack/router-core`.** The adapter's types come from router-core, and
IDEA §5's table already names it. The plan's evidence table still listed `@tanstack/react-start`,
which is now corrected.

**Guard:** `tooling/gates` fails when a package declares a framework peer with no `peer-floor` row,
when the row's version isn't the range's lower bound, or when a range uses `||`. Widening a range
therefore means adding the older version to the row and making it pass.
