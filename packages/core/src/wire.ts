/**
 * `@friday-friday/core/wire` — the wire envelope (RFC-0001 §5–§6, IDEA §4.2–§4.3).
 * Decision note: docs/decisions/2026-11-17-core-wire-subpath.md.
 *
 * One deep module at the seam every adapter (next, hono, trpc, http) crosses. Its interface is
 * four functions and a constant; the rules sit behind it, so a fix lands here once:
 *
 * - `sanitize(e, o?)`          JSON-safe projection `{ _tag, message?, ...safeProps }` (tRPC `data.fl`)
 * - `toProblem(e, s?, o?)`     RFC 9457 body; `s` = status | status map | RFC §6 defaults; a tag
 *                              with no status is masked as `InternalDefect` (`o.strict`: map only)
 * - `fromWire(body)`           problem body or sanitized error → tagged error (or `undefined`)
 * - `toDefect(c, rep?, dig?)`  the one `InternalDefect` envelope; the cause goes to `rep`, never the wire
 * - `PROBLEM_CONTENT_TYPE`
 *
 * Invariants: nothing here throws; every output deep-equals its own `JSON.parse(JSON.stringify(x))`
 * and `structuredClone(x)` (RFC-0001 §5.2); `cause` never appears in any output (IDEA §4.2);
 * `toProblem(fromWire(p)!, p.status)` deep-equals `p` for every `p` this module built; `message` is
 * a string or absent; every `InternalDefect` this module creates (`toDefect`, masking, the hostile-
 * input fallback) carries the fixed text and nothing from the original but an optional `digest`.
 */
import type { TaggedError } from "./index.js"

/** A value that survives `JSON.parse(JSON.stringify(x))` and `structuredClone(x)` unchanged. */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** A tagged error after projection: `_tag`, optional `message`, JSON-safe props only. */
export interface WireError<Tag extends string = string> {
  readonly _tag: Tag
  readonly message?: string
  readonly [prop: string]: Json | undefined
}

// ---------------------------------------------------------------------------
// JSON-safe projection (internal; every output of this module goes through it)
// ---------------------------------------------------------------------------

const MAX_DEPTH = 32

/** The only client-facing text a defect ever carries (IDEA §4.3). */
const DEFECT_MESSAGE = "Internal server error"

/** Own enumerable data property: never triggers the `__proto__` setter. */
const define = (o: object, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

/** Plain-object projection: drops `cause`, keys outside `allow` (if given) and props that project to nothing. */
const record = (
  o: object,
  depth: number,
  path: Array<object>,
  allow?: ReadonlyArray<string>
): { [key: string]: Json } => {
  const out: { [key: string]: Json } = {}
  for (const k of Object.keys(o)) {
    if (k === "cause" || (allow && !allow.includes(k))) continue
    let v: Json | undefined
    try {
      v = project(Reflect.get(o, k), depth + 1, path)
    } catch {
      v = undefined // throwing getter / proxy trap: dropped, never rethrown
    }
    if (v !== undefined) define(out, k, v)
  }
  return out
}

/** `undefined` means "drop". `path` holds the ancestors, so a cycle is cut where it closes. */
const project = (v: unknown, depth: number, path: Array<object>): Json | undefined => {
  switch (typeof v) {
    case "string":
    case "boolean":
      return v
    case "number":
      return Number.isFinite(v) ? (v === 0 ? 0 : v) : undefined // -0 → 0, NaN/±Infinity dropped
    case "object":
      break
    default:
      return undefined // bigint, function, symbol, undefined
  }
  if (v === null) return null
  if (depth >= MAX_DEPTH || path.includes(v)) return undefined
  try {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString()
    path.push(v)
    try {
      if (Array.isArray(v)) return Array.from(v, (x: unknown) => project(x, depth + 1, path) ?? null)
      const proto: unknown = Object.getPrototypeOf(v)
      return proto === Object.prototype || proto === null ? record(v, depth, path) : undefined
    } finally {
      path.pop()
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Per-call projection options. */
export interface WireOptions {
  /**
   * Allowlist of prop names that may cross (RFC-0001 §6 "allowlisted JSON-safe props"). When given,
   * every other prop is dropped; `_tag` and `message` always pass. Omitted = every JSON-safe prop.
   */
  readonly safeProps?: ReadonlyArray<string>
}

/**
 * JSON-safe projection of a tagged error (RFC-0001 §5.3): `_tag`, a string `message` and plain props
 * survive (only the props named in `options.safeProps`, when given); a non-string `message`,
 * `cause` (at every depth), functions, symbols, bigint, `undefined`, non-finite numbers, class
 * instances, cycles and anything deeper than 32 levels are dropped. `Date` → ISO string, `-0` → `0`,
 * a dropped array element → `null`. Never throws: an error whose `_tag` can't be read as a string
 * comes out as the defect envelope. The output round-trips JSON and `structuredClone`.
 */
export const sanitize = <E extends TaggedError<string>>(e: E, options?: WireOptions): WireError<E["_tag"]> => {
  const allow = options?.safeProps
  let out: { [key: string]: Json }
  try {
    out = record(e, 0, [e], allow && ["_tag", "message", ...allow])
  } catch {
    out = {} // the error object itself is hostile (throwing proxy trap)
  }
  // An unreadable or non-string tag can't be attributed: degrade to the defect envelope (no props
  // ride along under `InternalDefect`) rather than throw.
  if (typeof out["_tag"] !== "string") out = { _tag: "InternalDefect", message: DEFECT_MESSAGE }
  // `message` is a string or absent (RFC-0001 §2 `message?: string`): anything else is dropped.
  if (typeof out["message"] !== "string") delete out["message"]
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `_tag` is a string (ensured above); props are Json by construction
  return out as unknown as WireError<E["_tag"]>
}

// ---------------------------------------------------------------------------
// Problem Details (RFC 9457) — RFC-0001 §6
// ---------------------------------------------------------------------------

/** `content-type` for every problem body this module builds. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json" as const

/** RFC 9457 body. `tag` is the reconstruction key; `shadowed` carries props that collided with reserved members. */
export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
  readonly tag: string
  readonly shadowed?: { readonly [key: string]: Json }
  readonly [member: string]: Json | undefined
}

/** Explicit tag → status overrides (adapters' status maps are assignable to this). */
export interface StatusMap {
  readonly [tag: string]: number | undefined
}

/** Per-call options for `toProblem`. */
export interface ProblemOptions extends WireOptions {
  /**
   * Only the caller's `status` counts: a tag missing from the map (or a non-error status) is masked
   * as `InternalDefect`, instead of falling back to the RFC-0001 §6 table. `InternalDefect` is always 500.
   */
  readonly strict?: boolean
  /** Receives the original error when its tag resolves to no status and is masked as `InternalDefect`. */
  readonly report?: (cause: unknown) => void
}

/** Members an error prop can never overwrite; colliding props go into `shadowed`. */
const RESERVED: ReadonlyArray<string> = ["type", "title", "status", "detail", "instance", "tag", "shadowed"]

/**
 * RFC-0001 §6 fallbacks: adapters pass explicit maps, these only fill the gaps. A tag found nowhere
 * is a defect: "everything else → 500 as `InternalDefect`". `InternalDefect` itself is always 500.
 */
const DEFAULT_STATUS: { readonly [tag: string]: number } = {
  NotFound: 404,
  Forbidden: 403,
  Unauthenticated: 401,
  Conflict: 409,
  ValidationFailure: 422,
  InternalDefect: 500
}

/** A problem body may only claim an error: integers 400–599. */
const isErrorStatus = (s: unknown): s is number => typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599

/** `NotFound` → `Not Found`, `HTTPError` → `HTTP Error`. */
const words = (tag: string): string =>
  tag.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")

const typeUri = (tag: string): string =>
  `https://friday-friday.dev/errors/${encodeURIComponent(words(tag).toLowerCase().replace(/\s+/g, "-"))}`

/**
 * RFC 9457 problem body for a tagged error (RFC-0001 §6):
 * `{ type, title, status, detail: message, tag: _tag, ...safeProps, shadowed? }`.
 *
 * Status: an explicit number, else `status[tag]` from a map, else (unless `options.strict`) the
 * RFC §6 default (`NotFound 404`, `Forbidden 403`, `Unauthenticated 401`, `Conflict 409`,
 * `ValidationFailure 422`, `InternalDefect 500`). A status outside 400–599 counts as no status.
 * A tag that resolves to no status is a defect (RFC §6 "everything else → 500 as `InternalDefect`"):
 * the body is `toProblem(toDefect(e, options.report), 500)` — fixed text, no tag, no props — and the
 * original error goes to `options.report`. So `body.status` is always an error status; adapters send
 * it as the HTTP status with `PROBLEM_CONTENT_TYPE`. Props are projected by `sanitize` (with
 * `options.safeProps` as the allowlist); a prop named like a reserved member is carried in `shadowed`.
 */
export const toProblem = (
  e: TaggedError<string>,
  status?: number | StatusMap,
  options: ProblemOptions = {}
): Problem => {
  const { _tag: tag, message, ...props } = sanitize(e, options)
  const wanted = typeof status === "number" ? status : status?.[tag]
  const resolved = isErrorStatus(wanted)
    ? wanted
    : Object.hasOwn(DEFAULT_STATUS, tag) && (!options.strict || tag === "InternalDefect")
    ? DEFAULT_STATUS[tag]
    : undefined
  // RFC-0001 §6: a tag nobody gave a status is a defect — fixed text, no props; the original is reported.
  if (resolved === undefined) return toProblem(toDefect(e, options.report), 500)
  const body: { [member: string]: Json } = { type: typeUri(tag), title: words(tag), status: resolved }
  if (message !== undefined) body["detail"] = message
  body["tag"] = tag
  const shadowed: { [key: string]: Json } = {}
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) define(RESERVED.includes(k) ? shadowed : body, k, v)
  }
  if (Object.keys(shadowed).length > 0) body["shadowed"] = shadowed
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- type/title/status/tag set above; members are Json by construction
  return body as unknown as Problem
}

// ---------------------------------------------------------------------------
// Parse-back
// ---------------------------------------------------------------------------

/** Inverse of the default table, for problems that carry no `tag` (foreign producers). */
const TAG_FOR_STATUS: { readonly [status: string]: string } = {
  401: "Unauthenticated",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  422: "ValidationFailure",
  500: "InternalDefect"
}

const isPlainObject = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u)

const tagOf = (b: Record<string, unknown>): string | undefined => {
  const tag = b["tag"]
  if (typeof tag === "string") return tag
  const status = b["status"]
  return typeof status === "number" && Object.hasOwn(TAG_FOR_STATUS, status) ? TAG_FOR_STATUS[status] : undefined
}

/**
 * Rebuild a tagged error from the wire. Accepts either shape this module emits:
 * - a sanitized error (`{ _tag, ...props }`, e.g. tRPC `data.fl`) — re-projected as is;
 * - a problem body — `{ _tag: tag, message: detail, ...extension members, ...shadowed }`, with the
 *   transport members removed. With no `tag`, the inverse of the default status table applies
 *   (`404 → NotFound`, `403 → Forbidden`, `401 → Unauthenticated`, `409 → Conflict`,
 *   `422 → ValidationFailure`, `500 → InternalDefect`).
 *
 * `undefined` when the input can't be attributed to a tag — keep your own transport error then.
 * Input is untrusted: the output is re-projected (JSON-safe, own props only) and never throws.
 * `toProblem(fromWire(p)!, p.status)` deep-equals `p` for every `p` built by `toProblem`.
 */
export const fromWire = (body: unknown): WireError | undefined => {
  if (!isPlainObject(body)) return undefined
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `_tag` checked right here; sanitize re-projects the rest
    if (typeof body["_tag"] === "string") return sanitize(body as unknown as TaggedError<string>)
    const tag = tagOf(body)
    if (tag === undefined) return undefined
    const raw: Record<string, unknown> = {}
    for (const k of Object.keys(body)) if (!RESERVED.includes(k)) define(raw, k, body[k])
    if (typeof body["detail"] === "string") raw["message"] = body["detail"]
    const shadowed = body["shadowed"]
    if (isPlainObject(shadowed)) { for (const k of Object.keys(shadowed)) define(raw, k, shadowed[k]) }
    raw["_tag"] = tag // last: nothing on the wire can replace the reconstruction key
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `_tag` set on the line above
    return sanitize(raw as unknown as TaggedError<string>)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Defect envelope — IDEA §4.3, RFC-0001 §2 ("InternalDefect exists only at the wire")
// ---------------------------------------------------------------------------

/** The only defect shape that crosses a boundary: a fixed message, nothing from the cause. */
export interface InternalDefect extends WireError<"InternalDefect"> {
  readonly message: "Internal server error"
  /** Caller-supplied correlation id (RFC-0001 §2: `cause` is "stripped (or replaced by a digest)"). */
  readonly digest?: string
}

/**
 * Sanitize an unknown throw for the client: always
 * `{ _tag: "InternalDefect", message: "Internal server error", digest? }`. The original `cause` goes
 * to `report` (logging / OpenTelemetry) and is never placed in the envelope; `digest` (a string the
 * caller chose, e.g. a request or trace id, so support can find the report) is the only extra member.
 * Never throws: a throwing reporter is swallowed, because this is the outermost layer. Problem form:
 * `toProblem(toDefect(cause, report))` (default status 500).
 */
export const toDefect = (cause: unknown, report?: (cause: unknown) => void, digest?: string): InternalDefect => {
  try {
    report?.(cause)
  } catch {
    // the reporter failing must not turn a sanitized 500 into an unsanitized crash
  }
  return typeof digest === "string"
    ? { _tag: "InternalDefect", message: DEFECT_MESSAGE, digest }
    : { _tag: "InternalDefect", message: DEFECT_MESSAGE }
}
