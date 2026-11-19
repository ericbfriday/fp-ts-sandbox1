/**
 * `@friday-friday/hono` - Hono adapter (Design Report 5.2).
 *
 * Hono glue only. The wire rules (JSON-safe sanitize, the RFC 9457 body, tag -> status, the
 * `InternalDefect` envelope) live in `@friday-friday/core/wire` (RFC-0001 §5-§6, IDEA §4.2-§4.3,
 * decision note 2026-11-17-core-wire-subpath.md); validation issues are projected by
 * `@friday-friday/schema` (`parseAsync` -> `toValidationFailure`). This module keeps the
 * status-literal typing, `c.json`, the `onError` hook and HTTPException passthrough (#37).
 *
 * Traps absorbed:
 * - The `hc` client infers responses only from chained routes and literal status codes;
 *   returning `c.json(x, status as number)` collapses the union. `respond` maps each tagged
 *   error to its LITERAL status via the `StatusMap` so `res.status` stays a narrow union and
 *   `await res.json()` narrows per status.
 * - At runtime a tag missing from the map (a widened `E`, a cast) is a 500 `InternalDefect`,
 *   never a 2xx (core `toProblem` with `strict`, RFC-0001 §6 "everything else -> 500").
 * - Every problem goes out as `application/problem+json` (RFC 9457 §3); core `fromWire` rebuilds
 *   the tagged error on the client, so Hono <-> client round-trips are lossless.
 * - `sv(target, schema)` answers validation failures with a 422 `ValidationFailure` problem whose
 *   issues are exactly `{ message, path }` (root = `[]`, vendor extras such as `input` dropped).
 *   A vendor `validate` that throws is a defect (`Panic`), handled by `onErrorHandler`.
 * - `onErrorHandler` maps `HTTPException` to its own response (status AND headers preserved -
 *   the report marks header loss in onError as U, so it is a test case) and every other throw
 *   to core's `InternalDefect` problem (fixed message); the original goes to `report`.
 *
 * TS2589 guidance (report): split routes into sub-apps and export per-slice hc<typeof users>
 * clients; avoid one monolithic AppType.
 *
 * Peer range note: install range follows spec §4 (`^4.10 || ^5.0.0-0`); the CI matrix
 * TESTS hono 4.13.18 (exact pin — 4.13.19 violates pnpm's supply-chain minimumReleaseAge),
 * per §6 "lower bound = oldest version in the matrix". The 5.0.0-rc line changes onError
 * composition and c.json(undefined) (report trap 4) — the range admits rc installs but
 * rc behavior is NOT covered by testing; extend coverage before relying on it.
 */
import { err, ok, type Result, type TaggedError } from "@friday-friday/core"
import { type Problem, PROBLEM_CONTENT_TYPE, toDefect, toProblem } from "@friday-friday/core/wire"
import { parseAsync, type StandardSchemaV1 } from "@friday-friday/schema"
import type { Context, Env, ErrorHandler, MiddlewareHandler, TypedResponse, ValidationTargets } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
// NOTE: the report names hono sValidator, but NO hono version ships it (verified 4.13.19 +
// 5.0.0-rc.1 exports maps: only ./validator) - sv is built directly on hono validator.
import { validator as honoValidator } from "hono/validator"

/** Map each tagged-error `_tag` to its literal status code - literals keep hc inference narrow. */
export type StatusMap<E extends TaggedError<string>> = { readonly [K in E["_tag"]]: ContentfulStatusCode }

/** `c.json` with the RFC 9457 content type; `body.status` is always an error status (core invariant). */
const send = (c: Context, body: Problem): Response =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- core's toProblem only emits integer statuses 400-599
  c.json(body, body.status as ContentfulStatusCode, { "Content-Type": PROBLEM_CONTENT_TYPE })

/**
 * RFC 9457 problem body for a tagged error at `status`: core `toProblem(e, status)` (RFC-0001 §6).
 * Props are JSON-safe projected (`cause`, bigint, functions dropped), `message` becomes `detail`,
 * reserved-member collisions go into `shadowed`. A non-error `status` falls back to core's tag
 * default, and a tag with none is masked as `InternalDefect`.
 */
export function problem(e: TaggedError<string>, status: number): Problem {
  return toProblem(e, status)
}

/**
 * Return a handler response from a Result, preserving status-literal unions:
 * Ok(v) -> c.json(v, 200); Err(e) -> core's problem body at `statuses[e._tag]`, sent as
 * `application/problem+json`. A tag missing from `statuses` at runtime is a 500 `InternalDefect`.
 */
export function respond<T, E extends TaggedError<string>, const M extends StatusMap<E>>(
  c: Context,
  r: Result<T, E>,
  statuses: M
): Response & TypedResponse<T, 200, "json"> | Response & TypedResponse<Problem, M[E["_tag"]], "json"> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- hono's c.json TypedResponse brand is structurally unsound to express; the return type above carries it
  if (r.ok) return c.json(r.value, 200) as never
  // oxlint-disable-next-line no-unsafe-type-assertion -- same hono TypedResponse brand boundary as above
  return send(c, toProblem(r.error, statuses, { strict: true })) as never
}

/**
 * sv return type carries hono's in/out middleware metadata (the @hono/zod-validator
 * pattern) so handler inference keeps working - a bare MiddlewareHandler would make
 * valid() keys never.
 */
export type SvMiddleware<Target extends keyof ValidationTargets, Out> = MiddlewareHandler<
  Env,
  string,
  {
    in: { [K in Target]: ValidationTargets[Target] }
    out: { [K in Target]: Out }
  }
>

/**
 * sv(target, schema) validates a target with Standard Schema via schema's `parseAsync`; failures
 * answer with a 422 `ValidationFailure` problem instead of hono's default plain-text 400. Passing
 * values return the parsed output so c.req.valid(target) works. A throwing vendor rejects with
 * `Panic` and reaches `onErrorHandler` as a defect.
 */
export function sv<Target extends keyof ValidationTargets, Schema extends StandardSchemaV1>(
  target: Target,
  schema: Schema
): SvMiddleware<Target, StandardSchemaV1.InferOutput<Schema>> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- hono validator's generic shape cannot express the in/out metadata directly (zValidator uses the same boundary cast)
  return honoValidator(target as never, async (value: unknown, c) => {
    const r = await parseAsync(schema, value)
    // oxlint-disable-next-line no-unsafe-type-assertion -- validated output is InferOutput<Schema> by the Standard Schema contract
    return r.ok ? r.value as never : send(c, toProblem(r.error, 422))
  }) as SvMiddleware<Target, StandardSchemaV1.InferOutput<Schema>>
}

export interface OnErrorOptions {
  /** Receives the original throw (non-HTTPException) for observability; return value is ignored. */
  readonly report?: (cause: unknown) => void
}

/** Structural HTTPException check: survives duplicate hono copies (no instanceof reliance). */
const asHttpException = (e: unknown): HTTPException | null => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe: fields verified immediately below
  const candidate = e as { status?: unknown; getResponse?: unknown } | null
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.status === "number" &&
    typeof candidate.getResponse === "function"
  ) {
    // oxlint-disable-next-line no-unsafe-type-assertion -- structural shape verified field-by-field above
    return e as HTTPException
  }
  if (e instanceof HTTPException) return e
  return null
}

/**
 * onErrorHandler({ report }) - HTTPException responses pass through with their own
 * status AND headers (the report marks header loss in onError as U; the test suite
 * exercises it); every other throw becomes core's `InternalDefect` problem (500, fixed
 * message, nothing from the cause) and the original goes to `report` (IDEA §4.3).
 */
export function onErrorHandler(opts?: OnErrorOptions): ErrorHandler {
  return (thrown, c) => {
    const httpEx = asHttpException(thrown)
    if (httpEx !== null) return httpEx.getResponse()
    return send(c, toProblem(toDefect(thrown, opts?.report), 500))
  }
}

// Re-exported for ergonomic single-import handlers.
export { err, ok }
