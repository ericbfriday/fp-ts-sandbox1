# 2026-11-17 — `@friday-friday/core/wire`: one module owns the wire envelope (#33, parent #30)

IDEA.md §5 lists core's subpaths as `/async`, `/gen`, `/interop`. This note adds a fourth,
**`@friday-friday/core/wire`**, before any code lands (AGENTS.md: "To change one, stop and write a
note in `docs/decisions/` first"). It implements locked decisions IDEA §4.2 (`cause` stays
server-side, stripped before any boundary) and §4.3 (unknown throws become a sanitized
`InternalDefect` and the original is reported) together with RFC-0001 §5 (wire envelope) and §6
(Problem Details). **No locked decision changes.** The Result shape, plain-data errors, thrown
defects and erasable ESM are untouched.

## Why a subpath, and why in core

next, hono, trpc and http each re-implemented the envelope and drifted apart (#30 repros: bigint
props throw, `status`/`type` props overwrite problem members, `detail` never maps back to
`message`, two defect tags on the wire, defect text sent to clients). The deletion test says the
rules belong in one deep module. Core is the highest seam all four already import, and adapters
must not import each other (IDEA §5). A subpath keeps the root entry's size budget and lets apps
that never cross a wire boundary skip it.

## Interface

```ts
sanitize(e, { safeProps? }?)                     // JSON-safe projection { _tag, message?, ...safeProps } (RFC §5.3)
toProblem(e, status?, { strict?, safeProps?, report? }?)
                                                 // RFC 9457 body; status = number | StatusMap | default table;
                                                 // a tag with no status -> the InternalDefect body (RFC §6)
fromWire(body)                                   // problem body OR sanitized error -> WireError | undefined
toDefect(cause, report?, digest?)                // { _tag: "InternalDefect", message: <fixed>, digest? } (IDEA §4.3)
PROBLEM_CONTENT_TYPE                             // "application/problem+json"
```

Types: `Json`, `WireError<Tag>`, `WireOptions`, `ProblemOptions`, `Problem`, `StatusMap`, `InternalDefect`.

## Rules hidden behind it (normative for adapters)

1. **JSON-safe projection** (sanitize, and every output of the module): keeps `null`, booleans,
   strings, finite numbers (`-0` becomes `0`), arrays and plain objects (prototype `Object.prototype`
   or `null`). `Date` becomes its ISO string (an invalid Date is dropped). It drops `cause` **at
   every depth**, plus functions, symbols, bigint, `undefined`, `NaN`/`±Infinity`, class instances
   (`Map`, `Error`, …), cyclic references and anything nested deeper than 32 levels. `message` is a
   string or absent: a non-string `message` is dropped (RFC-0001 §2 types it `message?: string`, and
   `WireError.message` promises the same), not carried in `shadowed`, so parse-back can never hand a
   client a non-string `message`. With `safeProps` (RFC §6 "allowlisted JSON-safe props"), only the
   named top-level props pass; `_tag` and `message` always do. Without it, every JSON-safe prop passes. Inside arrays a
   dropped element becomes `null`, so indices survive, as `JSON.stringify` would do. Throwing
   getters and proxies are dropped, never rethrown. `__proto__` keys are written as own data
   properties, so a hostile body can't change prototypes. An error whose own `_tag` can't be read as
   a string (throwing proxy, throwing getter) becomes the defect envelope (`InternalDefect`, fixed
   text), so no unattributed props travel with it. Every output therefore satisfies RFC-0001
   §5.2: `JSON.parse(JSON.stringify(x))` and `structuredClone(x)` deep-equal `x`.
2. **Problem body** (RFC-0001 §6): `type = https://friday-friday.dev/errors/<kebab(_tag)>`,
   `title` = the tag split into words (`NotFound` → `Not Found`), `status`, `detail` = `message` (only
   when it is a string), `tag` = `_tag`, then the safe props as extension members.
3. **Reserved-member collision policy: carry, don't drop.** `type`, `title`, `status`, `detail`,
   `instance`, `tag` and `shadowed` are reserved. An error prop with one of these names is carried
   inside one namespaced extension member, `shadowed`, which is omitted when empty. The real `status`/`type` always win. Example: an `AuthApiError{ status: 401 }`
   mapped to 500 gives `{ status: 500, …, shadowed: { status: 401 } }`. `shadowed` is reserved itself,
   so a prop named `shadowed` nests inside it and the policy is closed. We chose carry over drop because
   #33 requires parse-back to be lossless "including props that collided with reserved members".
4. **Status resolution:** an explicit number wins; otherwise `StatusMap[tag]`; otherwise the RFC §6
   defaults: `NotFound 404`, `Forbidden 403`, `Unauthenticated 401`, `Conflict 409`,
   `ValidationFailure 422`, `InternalDefect 500`, and since ADR-0005 (#87) the infrastructure tags
   `NetworkError 502`, `DbUnavailable 503`, `Timeout 504`; the table is keyed by core's fixed-vocabulary
   factories' `.tag`. Those three infrastructure tags cross as tag + status only: `sanitize` and
   `toProblem` drop their `message` and props unless `safeProps` names them (`message` too), because
   driver and socket text leaks hosts and DSNs (ADR-0005, the leak class of #30). `fromWire` keeps
   whatever the server sent. A status outside the integer range 400–599 counts
   as no status, so a problem body can never claim success (fixes the hono "unmapped tag served as
   200" class of bug at the source). With `{ strict: true }` the defaults are skipped: only the
   caller's number or map counts (#37: "an Err whose tag isn't in the status map produces a 500").
   `InternalDefect` is always 500, strict or not, so the defect envelope never masks itself.
   Default (non-strict) behaviour stays "defaults fill gaps", as RFC §6 says ("adapters take
   explicit status maps; these are only fallbacks").
5. **A tag with no status is a defect** (resolves the PR #50 "judgement call 1", review of
   2026-11-18). RFC §6 says "everything else → `500` as `InternalDefect`", and RFC §2 says
   `InternalDefect` "exists only at the wire". We now read §6 literally: when a tag resolves to no
   status (not the caller's number, not the map, not the default table), `toProblem` returns
   `toProblem(toDefect(e, options.report), 500)`: tag `InternalDefect`, fixed `detail`, no props,
   and the original error goes to the caller's reporter (the same hook `toDefect` takes). The first
   draft kept the original tag and props at 500, on the grounds that a returned `Err` is plain data,
   not a defect. Review showed why that was wrong: an infrastructure error nobody mapped
   (`DbUnavailable { host: "db.internal:5432", message: "conn refused" }`) leaked its host and
   driver text to the client. An unmapped tag is one the developer never decided how to expose, and
   the safe default for an undecided exposure is the defect envelope. To expose a tag, give it a
   status (map entry or explicit number). Mapped tags keep the JSON-safe projection, narrowed by
   `safeProps` when the caller passes one.
6. **Parse-back** (`fromWire`): a sanitized error (string `_tag`) is re-projected as is. A problem
   body yields `{ _tag: tag, message: detail, ...extension members, ...shadowed }` with the transport
   members (`type`, `title`, `status`, `detail`, `instance`, `tag`, `shadowed`) removed. A problem with
   no `tag` falls back to the inverse of the default table (`404 → NotFound`, `403 → Forbidden`,
   `401 → Unauthenticated`, `409 → Conflict`, `422 → ValidationFailure`, `500 → InternalDefect`;
   the infrastructure statuses 502/503/504 are not attributed, since a tag-less 503 from a proxy says
   nothing about a database).
   Otherwise the result is `undefined`, so the caller keeps its own transport error (for example
   `HttpError`). Untrusted input is re-sanitized. `problem → fromWire → toProblem` is a fixed point (for an infrastructure body, when `toProblem` gets the
   same `safeProps` the server used)
   (a masked body parses back as the defect envelope, which resolves to 500 again).
7. **One defect envelope:** `toDefect(cause, report?, digest?)` always returns
   `{ _tag: "InternalDefect", message: "Internal server error" }` and hands the original `cause`
   to `report`. Nothing from the cause is placed in the envelope. The only optional member is
   `digest`, a string the caller chose (request or trace id), which RFC §2 permits ("stripped (or
   replaced by a digest)"); a non-string digest is ignored. The masked path in `toProblem` adds no
   digest; a caller that needs one there resolves the status itself or calls `toDefect` directly. A throwing reporter is swallowed:
   the envelope is the outermost layer and must not fail. Its problem form is
   `toProblem(toDefect(c), 500)`, and since its default status is 500, `toProblem(toDefect(c))` works too.

## Interface alternatives considered (design-it-twice)

- **Minimal codec** (`encode(e, status?)` / `decode(u)` / `defect`): the fewest entry points, but
  `encode` would return two different shapes (sanitized error vs problem body) depending on arity.
  tRPC's `data.friday_friday` (named `data.fl` when this note was written; renamed in #38) needs the first, and next and hono need the second. Rejected because it hides
  the difference badly.
- **Configurable factory** (`createWire({ typeBase, titles, statuses, collision, defectMessage })`):
  maximum flexibility, but every option is something RFC-0001 fixes normatively. Two adapters
  configured differently would bring back producer/consumer drift (#30 US-5, US-12). Rejected as
  speculative generality. The per-call options added after review are not that factory: `strict`
  and `safeProps` are the two choices RFC §6 itself leaves to the caller ("adapters take explicit
  status maps", "allowlisted JSON-safe props"), and `report` is the IDEA §4.3 reporter hook.
- **Response builder** (`problemResponse(result, statuses): Response`): trivial for next, but hono
  needs `c.json` for `hc` status-literal inference, and trpc and http never build a `Response`.
  We kept the useful part: status resolution is folded into `toProblem` (`body.status` is the
  resolved status) and the content type is exported once.
- **Chosen:** four functions and one constant. All four adapters call the same small interface,
  and §5–§6 rules live in one implementation (locality), so a fix lands once.

## Golden fixtures for adapters

Golden problem bodies live in `packages/core/test/wire-golden.ts`. Adapter tickets (#37–#40)
import them as **`@friday-friday/core/test/wire-golden`**, so they test against the real shape
instead of hand-copied fixtures, and without a relative path into core's test folder.

The subpath is declared in core's `exports` under the `@friday-friday/source` condition **only**
(no `types`, no `default`). That condition is set by `tsconfig.base.json` `customConditions` and
the root Vitest config, so it exists inside this workspace and nowhere else. `test/` is not in the
package's `files`. A consumer with ordinary conditions (Node, a bundler) gets
`ERR_PACKAGE_PATH_NOT_EXPORTED`; the core dist smoke asserts this. Options considered:

- relative import (`../../core/test/wire-golden.js`): zero manifest change, but every adapter
  reaches into another package's internals by path, and moving the file breaks them silently;
- a separate workspace package (`@friday-friday/test-fixtures`): clean, but a new package, a new
  dependency edge in four adapters and a lockfile change, for one file;
- a published subpath (`./testing` with `types`/`default` and the file in `files`): widens the
  runtime interface, which is what we wanted to avoid;
- **chosen:** one source-condition-only `exports` entry. It is the least widening option that
  still gives adapters a package-name import. Its only published trace is one manifest entry that
  resolves to nothing outside the workspace.
