# 2026-11-16 — Signal handling on the /async subpath (PR #12 review resolution)

IDEA.md §4.8 locks "retry, timeout, mapConcurrent, all taking `{ signal }`", and RFC-0001 §4
says every /async helper accepts `{ signal }`. The PR-12 two-axis review flagged two deviations.
Resolution (documented here rather than silently):

1. **Pure async duals take no options object.** `mapAsync`, `andThenAsync`, `orElseAsync`,
   `tapAsync`, `tapErrAsync` are pure value transforms — they cannot cancel anything themselves,
   so an options object would be dead weight and breaks the `arguments.length` dual dispatch
   (the data-last form already accepts a callback; a second params-object arg is ambiguous).
   Callers bind their own signal inside the callback closure.
2. **Cancellation-capable helpers forward `{ signal }` into the user callback/thunk**, so
   underlying work can actually observe cancellation (review requirement: "AbortSignal actually
   cancels underlying work"): `allAsync` (thunk arg), `mapConcurrent` (mapper 3rd arg),
   `retry` (fn arg), `timeout` (combined signal → thunk arg), `tryAsync` (unchanged).
3. **`timeout`'s signal moved from a positional param into `opts?: { signal }`** to match the
   options-object convention of the other helpers.
4. **Scope errata:** `orElseAsync`, `tapAsync`, `tapErrAsync` extend RFC-0001 §4's named /async
   inventory, mirroring the sync surface for completeness.

Re-test with a newer TS 7 patch: none of the above is compiler-dependent.
