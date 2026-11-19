/**
 * `@friday-friday/trpc` — tRPC v11 adapter (Design Report §5.3).
 *
 * Dual-channel design:
 * - **Error channel (default):** handlers return a Result; `resultMiddleware(map)` turns
 *   `Err(e)` into `throw new TRPCError({ code: map[e._tag] ?? "INTERNAL_SERVER_ERROR", cause: e })`,
 *   and `errorFormatter()` writes the wire form into `data.friday_friday`. Errors flow through
 *   tRPC's links into TanStack Query's error state, so retry / `throwOnError` / Error Boundaries behave.
 * - **Data channel (opt-in):** a plain procedure WITHOUT `resultMiddleware` resolves the Result
 *   as its output (tagged errors are plain data and survive JSON) — useful for
 *   `useActionState`-like form flows where a rejection is a legitimate outcome. No helper is
 *   needed (#64 deleted the identity `resultProcedure`).
 *
 * Result primitives (`ok`, `err`, `taggedError`, `TaggedError`) come from `@friday-friday/core`;
 * this package exports tRPC glue only (#44 decision 6, #64).
 *
 * tRPC glue only (#38, parent #30). The wire rules (JSON-safe sanitize, the `InternalDefect`
 * envelope, parse-back) live in `@friday-friday/core/wire` (RFC-0001 §5, IDEA §4.2–§4.3,
 * docs/decisions/2026-11-17-core-wire-subpath.md); validation issues are projected by
 * `@friday-friday/schema` `toValidationFailure` (message + path only, never the vendor's `input`).
 * Formatting is STRUCTURAL — never `instanceof ZodError` — so Valibot and ArkType format alike.
 *
 * Member name: `data.friday_friday`, the `friday_friday` namespace of RFC-0001 §7 (the one
 * otel's `friday_friday.error.tag` uses). The Design Report's `data.fl` was a placeholder.
 *
 * Documented design limit (report §5.3): tRPC infers the formatter shape GLOBALLY, not per
 * procedure, so the client-side error type is declared (via `fromTRPC<T, E>`), not inferred.
 * oRPC v2's per-procedure `.errors()` is genuinely better here.
 */
import {
  type AsyncResult,
  err,
  type ErrorFactory,
  isResult,
  ok,
  type TaggedError,
  taggedError
} from "@friday-friday/core"
import { fromWire, sanitize as project, toDefect, type WireError } from "@friday-friday/core/wire"
import { type IssueLike, toValidationFailure } from "@friday-friday/schema"
// Stable root entry point only (#57): every tRPC type here comes from `@trpc/server` and exists
// there on the oldest peer (11.0.0). Never import `@trpc/server/unstable-core-do-not-import`:
// it lands in dist/index.d.ts and a tRPC minor release could break consumers' builds.
// `AnyTRPCMiddlewareFunction` is the root name since 11.0.0. The middleware marker is branded
// internally, so the boundary cast in `resultMiddleware` stays unavoidable outside tRPC's types.
import { type AnyTRPCMiddlewareFunction, TRPCError } from "@trpc/server"

/**
 * tRPC error code union, derived from the stable root `TRPCError` class. `TRPC_ERROR_CODE_KEY`
 * is only a root export in later 11.x releases (11.0.0 has it under unstable-core), so naming
 * it would break the `^11` peer floor (#57).
 */
type TRPCErrorCode = TRPCError["code"]

export const TRPCTransportError: ErrorFactory<
  "TRPCTransportError",
  { readonly code?: string; readonly message: string }
> = taggedError("TRPCTransportError")<{
  readonly code?: string
  readonly message: string
}>()
export type TRPCTransportError = ReturnType<typeof TRPCTransportError>

/** A string `_tag`, read without trusting the value (`null`, primitives and wrappers alike). */
const tagOf = (u: unknown): unknown =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe; the caller checks the type
  (u as { _tag?: unknown } | null | undefined)?._tag

/**
 * The `data.friday_friday` projection of a tagged error: core `/wire` `sanitize` — `_tag`, a
 * string `message` and JSON-safe props survive; `cause`, bigint, functions and class instances
 * are dropped. Never throws.
 */
export function sanitize(e: TaggedError<string>): WireError {
  return project(e)
}

/** Options for `errorFormatter`. */
export interface ErrorFormatterOptions {
  /**
   * Receives the original throw of every defect (`INTERNAL_SERVER_ERROR`) before it is masked,
   * for logging / OpenTelemetry (IDEA §4.3). A throwing reporter is swallowed.
   */
  readonly report?: (cause: unknown) => void
}

/** The formatter `errorFormatter()` returns: tRPC's shape plus the `friday_friday` member. */
export type ErrorFormatter = <TShape extends { message: string; data: object }>(opts: {
  shape: TShape
  error: TRPCError
}) => TShape & { data: TShape["data"] & { friday_friday: WireError | null } }

/**
 * tRPC errorFormatter factory: `initTRPC.create({ errorFormatter: errorFormatter({ report }) })`.
 * `data.friday_friday` holds, by tRPC error code and cause:
 * - `INTERNAL_SERVER_ERROR` (a raw throw, a `Panic`, or an `Err` whose tag `resultMiddleware`
 *   had no code for): core's `InternalDefect` envelope with the fixed text, and the original
 *   goes to `report`. Outside tRPC's `isDev`, `shape.message` becomes the same fixed text. tRPC
 *   sets `data.stack` only in dev, so a shape without it counts as production (fail-safe);
 * - a tagged-error cause: core `sanitize(e)`;
 * - Standard Schema issues (input validation, any vendor): schema's `ValidationFailure`, each
 *   issue reduced to `{ message, path }`;
 * - anything else (a deliberate `TRPCError`): `null`, message untouched.
 */
export function errorFormatter(options: ErrorFormatterOptions = {}): ErrorFormatter {
  return ({ shape, error }) => {
    const cause: unknown = error.cause
    // oxlint-disable-next-line no-unsafe-type-assertion -- structural probe: `issues` is checked with Array.isArray below
    const issues = (cause as { issues?: unknown } | undefined)?.issues
    let message = shape.message
    let wire: WireError | null = null
    if (error.code === "INTERNAL_SERVER_ERROR") {
      wire = toDefect(cause ?? error, options.report)
      if (!("stack" in shape.data)) message = wire.message ?? message
    } else if (typeof tagOf(cause) === "string") {
      // oxlint-disable-next-line no-unsafe-type-assertion -- `_tag` is a string (checked); sanitize re-projects the rest
      const e = cause as TaggedError<string>
      // tRPC wraps a plain-object cause in an Error (`UnknownCauseError`) whose own `message` is
      // non-enumerable, so it is copied back explicitly; an absent message stays absent.
      const { message: own } = e
      wire = project(Object.hasOwn(e, "message") && typeof own === "string" ? { ...e, message: own } : e)
    } else if (Array.isArray(issues)) {
      // oxlint-disable-next-line no-unsafe-type-assertion -- vendor issues; the projection is total over arrays
      wire = project(toValidationFailure(issues as ReadonlyArray<IssueLike>))
    }
    return { ...shape, message, data: { ...shape.data, friday_friday: wire } }
  }
}

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
 * Error-channel middleware: a handler returning a Result (core `isResult`) has `Err` thrown as
 * `TRPCError({ code: map[e._tag] ?? "INTERNAL_SERVER_ERROR", cause: e })` — the error channel
 * fires retry/boundaries correctly — and `Ok` unwrapped to the value. Only the map's OWN keys
 * count (a tag such as `constructor` is unmapped). An unmapped tag is a defect at the formatter.
 * Non-Result outputs pass through untouched.
 *
 * NOTE: the returned middleware is asserted at the boundary - tRPC brands its middleware
 * marker (`"middlewareMarker" & { __brand }`) so the structural OK shape cannot be
 * expressed outside tRPC's own types. The runtime contract is proven in the wire tests;
 * output-type metadata stays the handler's declared return (the Result), which is the
 * report's documented "declared, not inferred" design limit anyway.
 */
export function resultMiddleware(map: { readonly [tag: string]: TRPCErrorCode }): AnyTRPCMiddlewareFunction {
  const mw = async ({ next }: { next: () => Promise<NextOut> }): Promise<NextOut> => {
    const out = await next()
    if (!out.ok || !isResult(out.data)) return out
    const r = out.data
    if (r.ok) return { ok: true as const, marker: "middleware" as const, data: r.value }
    const tag = tagOf(r.error)
    const code = typeof tag === "string" && Object.hasOwn(map, tag) ? map[tag] : undefined
    throw new TRPCError({ code: code ?? "INTERNAL_SERVER_ERROR", cause: r.error })
  }
  // oxlint-disable-next-line no-unsafe-type-assertion -- tRPC brands the middleware marker; runtime contract proven in wire tests
  return mw as unknown as AnyTRPCMiddlewareFunction
}

/**
 * Client-side bridge: a tRPC call promise resolved as a Result. A `TRPCClientError` whose
 * `data.friday_friday` holds a wire error is rebuilt by core `fromWire` (`_tag`, `message` and
 * props survive; a `ValidationFailure` keeps its `{ message, path }` issues). The defect
 * envelope (`InternalDefect`, never in `E`) and anything else become `Err(TRPCTransportError)`
 * carrying tRPC's code and message.
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
      // oxlint-disable-next-line no-unsafe-type-assertion -- TRPCClientError fields are structurally accessed; fromWire re-projects untrusted input
      const { data, message } = Object(cause) as {
        data?: { friday_friday?: unknown; code?: unknown }
        message?: unknown
      }
      const wire = fromWire(data?.friday_friday)
      const code = data?.code
      // oxlint-disable-next-line no-unsafe-type-assertion -- rebuilt from our own errorFormatter's wire form; E is caller-declared (report 5.3)
      if (wire !== undefined && wire._tag !== "InternalDefect") return err(wire as unknown as E)
      const msg = typeof message === "string" ? message : "transport error"
      return err(
        typeof code === "string" ? TRPCTransportError({ code, message: msg }) : TRPCTransportError({ message: msg })
      )
    }
  })()
}
