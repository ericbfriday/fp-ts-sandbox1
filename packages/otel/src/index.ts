/**
 * `@friday-friday/otel` — OpenTelemetry span helpers for Results
 * (Design Report §3.6 observability, §4 package table).
 *
 * `traced(name, fn)` runs `fn` inside a span. On `Err` the span status is set to
 * `ERROR` with attribute `fl.error.tag = <_tag>` and NO exception is recorded:
 * expected errors and bugs separate cleanly in dashboards. Defects (thrown, e.g.
 * `Panic`) are recorded as exceptions and rethrown.
 *
 * With no SDK registered the global tracer is a no-op, so the helper is safe on
 * every runtime (edge included) — observability is additive.
 */
import type { AsyncResult, Result, TaggedError } from "@friday-friday/core"
import { type Attributes, type Span, type SpanOptions, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api"

/** Attribute key carrying the tagged-error `_tag` of an `Err` result. */
export const ERROR_TAG_ATTR = "fl.error.tag"

export interface TracedOptions {
  /** Span attributes applied at start (e.g. `{"http.route": "/users/:id"}`). */
  readonly attributes?: Attributes
  /** Explicit tracer; defaults to the global tracer for `@friday-friday`. */
  readonly tracer?: Tracer
}

/**
 * Run an AsyncResult-producing function inside a span.
 * - `Ok(v)` → span ends `UNSET`, value returned.
 * - `Err(e)` → span status `ERROR`, attribute `fl.error.tag = e._tag` (no exception record).
 * - thrown defect → recorded as an exception event, status `ERROR`, rethrown as-is.
 */
/** Shared span semantics: Err marks (NO exception record), defects record + rethrow, span always ends. */
const settle = <T, E extends TaggedError<string>>(span: Span, r: Result<T, E>): Result<T, E> => {
  if (!r.ok) {
    // Expected failure: tag the span, do NOT record an exception — expected
    // errors and bugs must stay separable in dashboards.
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.setAttribute(ERROR_TAG_ATTR, r.error._tag)
  }
  return r
}

/** Defect: record the exception (event) + mark ERROR; caller rethrows unchanged. */
const recordDefect = (span: Span, cause: unknown): void => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- OTel's Exception is structurally {name?, message?, stack?}; defects may be plain data
  span.recordException(cause as Error)
  span.setStatus({ code: SpanStatusCode.ERROR })
}

export function traced<T, E extends TaggedError<string>>(
  name: string,
  fn: (span: Span) => Promise<Result<T, E>>,
  opts?: TracedOptions
): AsyncResult<T, E> {
  const tracer = opts?.tracer ?? trace.getTracer("@friday-friday")
  const spanOpts: SpanOptions = opts?.attributes === undefined ? {} : { attributes: opts.attributes }
  return tracer.startActiveSpan(name, spanOpts, async (span) => {
    try {
      return settle(span, await fn(span))
    } catch (cause) {
      recordDefect(span, cause)
      throw cause
    } finally {
      span.end()
    }
  })
}

/** Sync-Result variant for synchronous spans. */
export function tracedSync<T, E extends TaggedError<string>>(
  name: string,
  fn: (span: Span) => Result<T, E>,
  opts?: TracedOptions
): Result<T, E> {
  const tracer = opts?.tracer ?? trace.getTracer("@friday-friday")
  const spanOpts: SpanOptions = opts?.attributes === undefined ? {} : { attributes: opts.attributes }
  return tracer.startActiveSpan(name, spanOpts, (span) => {
    try {
      return settle(span, fn(span))
    } catch (cause) {
      recordDefect(span, cause)
      throw cause
    } finally {
      span.end()
    }
  })
}

export type { Attributes, Span, Tracer }
