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
sanitize(e)                    // JSON-safe projection { _tag, message?, ...safeProps }      (RFC §5.3)
toProblem(e, status?)          // RFC 9457 body; status = number | StatusMap | default table (RFC §6)
fromWire(body)                 // problem body OR sanitized error -> WireError | undefined   (RFC §6 "tag")
toDefect(cause, report?)       // { _tag: "InternalDefect", message: <fixed> }; original -> report (IDEA §4.3)
PROBLEM_CONTENT_TYPE           // "application/problem+json"
```

Types: `Json`, `WireError<Tag>`, `Problem`, `StatusMap`, `InternalDefect`.

## Rules hidden behind it (normative for adapters)

1. **JSON-safe projection** (sanitize, and every output of the module): keeps `null`, booleans,
   strings, finite numbers (`-0` becomes `0`), arrays and plain objects (prototype `Object.prototype`
   or `null`). `Date` becomes its ISO string (an invalid Date is dropped). It drops `cause` **at
   every depth**, plus functions, symbols, bigint, `undefined`, `NaN`/`±Infinity`, class instances
   (`Map`, `Error`, …), cyclic references and anything nested deeper than 32 levels. Inside arrays a
   dropped element becomes `null`, so indices survive, as `JSON.stringify` would do. Throwing
   getters and proxies are dropped, never rethrown. `__proto__` keys are written as own data
   properties, so a hostile body can't change prototypes. An error whose own `_tag` can't be read as
   a string (throwing proxy, throwing getter) becomes a bare `{ _tag: "InternalDefect" }`, so no
   unattributed props travel with it. Every output therefore satisfies RFC-0001
   §5.2: `JSON.parse(JSON.stringify(x))` and `structuredClone(x)` deep-equal `x`.
2. **Problem body** (RFC-0001 §6): `type = https://friday-friday.dev/errors/<kebab(_tag)>`,
   `title` = the tag split into words (`NotFound` → `Not Found`), `status`, `detail` = `message` (only
   when it is a string), `tag` = `_tag`, then the safe props as extension members.
3. **Reserved-member collision policy: carry, don't drop.** `type`, `title`, `status`, `detail`,
   `instance`, `tag` and `shadowed` are reserved. An error prop with one of these names (and a
   non-string `message`) is carried inside one namespaced extension member, `shadowed`, which is
   omitted when empty. The real `status`/`type` always win. Example: an `AuthApiError{ status: 401 }`
   mapped to 500 gives `{ status: 500, …, shadowed: { status: 401 } }`. `shadowed` is reserved itself,
   so a prop named `shadowed` nests inside it and the policy is closed. We chose carry over drop because
   #33 requires parse-back to be lossless "including props that collided with reserved members".
4. **Status resolution:** an explicit number wins; otherwise `StatusMap[tag]`; otherwise the RFC §6
   defaults: `NotFound 404`, `Forbidden 403`, `Unauthenticated 401`, `Conflict 409`,
   `ValidationFailure 422`, everything else `500`. A resolved status outside the integer range
   400–599 falls back to the default for the tag, so a problem body can never claim success (fixes
   the hono "unmapped tag served as 200" class of bug at the source).
5. **Unmapped tags keep their tag.** RFC §6 says "everything else → 500 as `InternalDefect`". We read
   this as the *status* fallback. An `Err` the developer chose to return is plain data in `E`, not a
   defect (defects are throws, IDEA §4.3), so its body keeps `tag` and safe props at status 500. Only
   `toDefect` produces `InternalDefect`. (Judgement call. If Eric wants unmapped tags masked, it is
   a one-line change in `toProblem`, and adapters inherit it.)
6. **Parse-back** (`fromWire`): a sanitized error (string `_tag`) is re-projected as is. A problem
   body yields `{ _tag: tag, message: detail, ...extension members, ...shadowed }` with the transport
   members (`type`, `title`, `status`, `detail`, `instance`, `tag`, `shadowed`) removed. A problem with
   no `tag` falls back to the inverse of the default table (`404 → NotFound`, `403 → Forbidden`,
   `401 → Unauthenticated`, `409 → Conflict`, `422 → ValidationFailure`, `500 → InternalDefect`).
   Otherwise the result is `undefined`, so the caller keeps its own transport error (for example
   `HttpError`). Untrusted input is re-sanitized. `problem → fromWire → toProblem` is a fixed point.
7. **One defect envelope:** `toDefect(cause, report?)` always returns
   `{ _tag: "InternalDefect", message: "Internal server error" }` and hands the original `cause`
   to `report`. Nothing from the cause is placed in the envelope. A throwing reporter is swallowed:
   the envelope is the outermost layer and must not fail. Its problem form is
   `toProblem(toDefect(c), 500)`, and since its default status is 500, `toProblem(toDefect(c))` works too.

## Interface alternatives considered (design-it-twice)

- **Minimal codec** (`encode(e, status?)` / `decode(u)` / `defect`): the fewest entry points, but
  `encode` would return two different shapes (sanitized error vs problem body) depending on arity.
  tRPC's `data.fl` needs the first, and next and hono need the second. Rejected because it hides
  the difference badly.
- **Configurable factory** (`createWire({ typeBase, titles, statuses, collision, defectMessage })`):
  maximum flexibility, but every option is something RFC-0001 fixes normatively. Two adapters
  configured differently would bring back producer/consumer drift (#30 US-5, US-12). Rejected as
  speculative generality.
- **Response builder** (`problemResponse(result, statuses): Response`): trivial for next, but hono
  needs `c.json` for `hc` status-literal inference, and trpc and http never build a `Response`.
  We kept the useful part: status resolution is folded into `toProblem` (`body.status` is the
  resolved status) and the content type is exported once.
- **Chosen:** four functions and one constant. All four adapters call the same small interface,
  and §5–§6 rules live in one implementation (locality), so a fix lands once.

Golden problem bodies live in `packages/core/test/wire-golden.ts`. Adapter tickets (#37–#40)
import them, so they test against the real shape instead of hand-copied fixtures.
