/**
 * `@friday-friday/trpc` — tRPC v11 adapter (Design Report §5.3).
 *
 * Dual-channel design:
 * - **Error channel (default):** handlers return a Result; `resultMiddleware(map)` turns
 *   `Err(e)` into `throw new TRPCError({ code: map[e._tag], cause: e })`, and `errorFormatter`
 *   writes the sanitized tagged error into `data.fl`. Errors flow through tRPC's links into
 *   TanStack Query's error state, so retry / `throwOnError` / Error Boundaries behave.
 * - **Data channel (opt-in):** `resultProcedure({ channel: "data" })` resolves the Result as
 *   plain output (tagged errors are plain data and survive JSON) — useful for
 *   `useActionState`-like form flows where a rejection is a legitimate outcome.
 *
 * Formatting uses the STRUCTURAL tagged-error shape and Standard Schema issue shape — never
 * `instanceof ZodError` — so Valibot and ArkType inputs format identically.
 *
 * Documented design limit (report §5.3): tRPC infers the formatter shape GLOBALLY, not per
 * procedure, so the client-side error type is declared (via `fromTRPC<T, E>`), not inferred.
 * oRPC v2's per-procedure `.errors()` is genuinely better here.
 */
import { type TRPC_ERROR_CODE_KEY, TRPCError } from "@trpc/server"
// types-only import (peer policy: types-only deps allowed) - MiddlewareFunction is branded
// internally, so the boundary cast below is unavoidable outside tRPC's own types.
import {
  type AsyncResult,
  err,
  type ErrorFactory,
  ok,
  type Result,
  type TaggedError,
  taggedError
} from "@friday-friday/core"
import type { AnyMiddlewareFunction } from "@trpc/server/unstable-core-do-not-import"

export const TRPCTransportError: ErrorFactory<
  "TRPCTransportError",
  { readonly code?: string; readonly message: string }
> = taggedError("TRPCTransportError")<{
  readonly code?: string
  readonly message: string
}>()
export type TRPCTransportError = ReturnType<typeof TRPCTransportError>

/** Structural tagged-error check (no instanceof: safe across module copies and JSON). */
const asTagged = (u: unknown): TaggedError<string> & Record<string, unknown> | null => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe: _tag verified immediately below
  const candidate = u as { _tag?: unknown } | null
  if (candidate !== null && typeof candidate === "object" && typeof candidate._tag === "string") {
    // oxlint-disable-next-line no-unsafe-type-assertion -- verified field-by-field above
    // oxlint-disable-next-line no-unsafe-type-assertion -- verified: _tag is a string field
    return u as TaggedError<string> & Record<string, unknown>
  }
  return null
}

/** Structural Standard Schema issue array check (works for zod/valibot/arktype alike). */
const asStandardIssues = (u: unknown): ReadonlyArray<{ message?: string; path?: ReadonlyArray<unknown> }> | null => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe
  const candidate = u as { issues?: unknown } | null
  if (candidate !== null && typeof candidate === "object" && Array.isArray(candidate.issues)) {
    // oxlint-disable-next-line no-unsafe-type-assertion -- issues verified as array above
    return candidate.issues as ReadonlyArray<{ message?: string; path?: ReadonlyArray<unknown> }>
  }
  return null
}

/**
 * JSON-safe projection of a tagged error for the `data.fl` member: tag + plain props
 * (message/cause excluded — cause is rarely JSON-safe and never crosses a boundary).
 */
export function sanitize(e: TaggedError<string>): Record<string, unknown> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- tagged errors are plain data (IDEA.md 4.2); message/cause are transport-excluded
  const { _tag, message, cause, ...safeProps } = e as TaggedError<string> & {
    message?: unknown
    cause?: unknown
    [key: string]: unknown
  }
  void message
  void cause
  return { _tag, ...safeProps }
}

export interface FlMeta {
  /** The sanitized tagged error, when the failure came from the domain channel. */
  readonly tag?: string
  readonly [key: string]: unknown
}

/** Standard Schema issue shape projected into `data.fl` (validator failures). */
export interface FlValidation {
  readonly tag: "ValidationError"
  readonly issues: ReadonlyArray<{ message?: string; path?: ReadonlyArray<unknown> }>
}

/**
 * tRPC errorFormatter: attaches `data.fl` — the sanitized tagged error for domain errors,
 * the Standard Schema issues for validator errors (STRUCTURAL: zod/valibot/arkType alike),
 * `null` otherwise.
 */
export function errorFormatter<TShape extends { data: Record<string, unknown> }>(opts: {
  shape: TShape
  error: { cause?: unknown }
}): TShape & { data: TShape["data"] & { fl: FlMeta | FlValidation | null } } {
  const cause = opts.error.cause
  const tagged = asTagged(cause)
  let fl: FlMeta | FlValidation | null = null
  if (tagged !== null) {
    fl = sanitize(tagged)
  } else {
    const issues = asStandardIssues(cause)
    if (issues !== null) fl = { tag: "ValidationError", issues }
  }
  return {
    ...opts.shape,
    data: { ...opts.shape.data, fl }
  }
}

/** Structural Result check for middleware pass-through (plain data: `ok` discriminates). */
const asResult = (u: unknown): Result<unknown, TaggedError<string>> | null => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe
  const candidate = u as { ok?: unknown; value?: unknown; error?: unknown } | null
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.ok === "boolean" &&
    (candidate.ok || asTagged(candidate.error) !== null)
  ) {
    // oxlint-disable-next-line no-unsafe-type-assertion -- ok/_tag verified above
    return u as Result<unknown, TaggedError<string>>
  }
  return null
}

/**
 * Error-channel middleware: a handler returning a Result has `Err` thrown as
 * `TRPCError({ code: map[e._tag] ?? "INTERNAL_SERVER_ERROR", cause: e })` — the error
 * channel fires retry/boundaries correctly — and `Ok` unwrapped to the value.
 * Non-Result outputs pass through untouched.
 */
/** tRPC middleware result shape: OK results carry the "middleware" marker. */
export interface NextOkOut {
  ok: true
  marker: "middleware"
  data: unknown
}

export interface NextErrOut {
  ok: false
  error: TRPCError
}

export type NextOut = NextOkOut | NextErrOut

/**
 * NOTE: the returned middleware is asserted at the boundary - tRPC brands its middleware
 * marker (`"middlewareMarker" & { __brand }`) so the structural OK shape cannot be
 * expressed outside tRPC's own types. The runtime contract is proven in the wire tests;
 * output-type metadata stays the handler's declared return (the Result), which is the
 * report's documented "declared, not inferred" design limit anyway.
 */
export function resultMiddleware(map: { readonly [tag: string]: TRPC_ERROR_CODE_KEY }): AnyMiddlewareFunction {
  const mw = async ({ next }: { next: () => Promise<NextOut> }): Promise<NextOut> => {
    const out = await next()
    if (!out.ok) return out
    const r = asResult(out.data)
    if (r === null) return out
    if (!r.ok) {
      const code = (map as Record<string, TRPC_ERROR_CODE_KEY>)[r.error._tag] ?? "INTERNAL_SERVER_ERROR"
      throw new TRPCError({ code, cause: r.error })
    }
    return { ok: true as const, marker: "middleware" as const, data: r.value }
  }
  // oxlint-disable-next-line no-unsafe-type-assertion -- tRPC brands the middleware marker; runtime contract proven in wire tests
  return mw as unknown as AnyMiddlewareFunction
}

/**
 * Data-channel procedure factory: the Result itself is the output (tagged errors are plain
 * data and survive tRPC's JSON transformer) — for `useActionState`-like form flows.
 */
export function resultProcedure(opts: { readonly channel: "data" }): <B>(builder: B) => B {
  void opts
  return <B>(builder: B): B => builder
}

/**
 * Client-side bridge: a tRPC call promise resolved as a Result. A `TRPCClientError` whose
 * `data.fl` carries a sanitized tagged error is reconstructed (lossless round-trip);
 * `data.fl` with ValidationError issues becomes a `ValidationError` tagged error; anything
 * else is `Err(TRPCTransportError)`.
 *
 * The error type is DECLARED here, not inferred — tRPC types the formatter shape globally,
 * not per procedure (report §5.3 design limit, documented).
 */
export function fromTRPC<T, E extends TaggedError<string> = TRPCTransportError>(
  // tRPC client calls return a TRPCTaggedPromise (a PromiseLike); T is DECLARED by the
  // caller - tRPC types the formatter shape globally, not per procedure (report 5.3).
  promise: PromiseLike<unknown>
): AsyncResult<T, E | TRPCTransportError> {
  return (async () => {
    try {
      // oxlint-disable-next-line no-unsafe-type-assertion -- T is declared by the caller (report 5.3: declared, not inferred)
      return ok((await promise) as T)
    } catch (cause) {
      // oxlint-disable-next-line no-unsafe-type-assertion -- TRPCClientError.data is structurally accessed; verified below
      const fl = asTagged((cause as { data?: { fl?: unknown } } | null)?.data?.fl)
      if (fl !== null) {
        // oxlint-disable-next-line no-unsafe-type-assertion -- fl came from our own sanitize() on the wire; E is caller-declared (report 5.3)
        return err(fl as unknown as E)
      }
      // oxlint-disable-next-line no-unsafe-type-assertion -- TRPCClientError.data is structurally accessed; verified below
      const issues = asStandardIssues((cause as { data?: { fl?: unknown } } | null)?.data?.fl)
      if (issues !== null) {
        const ValidationError = taggedError("ValidationError")<{ issues: typeof issues }>()
        // oxlint-disable-next-line no-unsafe-type-assertion -- ValidationError reconstructed from ~standard issues; E is caller-declared
        return err(ValidationError({ issues }) as unknown as E)
      }
      // oxlint-disable-next-line no-unsafe-type-assertion -- TRPCClientError fields are structurally accessed
      const code = (cause as { code?: unknown } | null)?.code
      // oxlint-disable-next-line no-unsafe-type-assertion -- TRPCClientError fields are structurally accessed
      const message = (cause as { message?: unknown } | null)?.message
      const codeStr = typeof code === "string" ? code : undefined
      const msg = typeof message === "string" ? message : "transport error"
      const transportError = codeStr === undefined
        ? TRPCTransportError({ message: msg })
        : TRPCTransportError({ code: codeStr, message: msg })
      // oxlint-disable-next-line no-unsafe-type-assertion -- E is caller-declared (report 5.3); transport error is our own construction
      return err(transportError as unknown as E)
    }
  })()
}

export { err, ok, type TaggedError, taggedError }
