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
import type { AsyncResult, TaggedError } from "@friday-friday/core"
import {
  type Attributes,
  type AttributeValue,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
  type Tracer
} from "@opentelemetry/api"

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
export function traced<T, E extends TaggedError<string>>(
  name: string,
  fn: (span: Span) => Promise<ResultLike<T, E>>,
  opts?: TracedOptions
): AsyncResult<T, E> {
  const tracer = opts?.tracer ?? trace.getTracer("@friday-friday")
  const spanOpts: SpanOptions = opts?.attributes === undefined ? {} : { attributes: opts.attributes }
  return tracer.startActiveSpan(name, spanOpts, async (span) => {
    try {
      const r = await fn(span)
      if (!r.ok) {
        // Expected failure: tag the span, do NOT record an exception — expected
        // errors and bugs must stay separable in dashboards.
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.setAttribute(ERROR_TAG_ATTR, r.error._tag)
      }
      return r
    } catch (cause) {
      // Defect: record the exception (event), then propagate unchanged.
      // oxlint-disable-next-line no-unsafe-type-assertion -- OTel's Exception is structurally {name?, message?, stack?}; defects may be plain data
      span.recordException(cause as Error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw cause
    } finally {
      span.end()
    }
  })
}

/** Sync-Result variant for synchronous spans. */
export function tracedSync<T, E extends TaggedError<string>>(
  name: string,
  fn: (span: Span) => ResultLike<T, E>,
  opts?: TracedOptions
): ResultLike<T, E> {
  const tracer = opts?.tracer ?? trace.getTracer("@friday-friday")
  const spanOpts: SpanOptions = opts?.attributes === undefined ? {} : { attributes: opts.attributes }
  return tracer.startActiveSpan(name, spanOpts, (span) => {
    try {
      const r = fn(span)
      if (!r.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.setAttribute(ERROR_TAG_ATTR, r.error._tag)
      }
      return r
    } catch (cause) {
      // oxlint-disable-next-line no-unsafe-type-assertion -- OTel's Exception is structurally {name?, message?, stack?}; defects may be plain data
      span.recordException(cause as Error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw cause
    } finally {
      span.end()
    }
  })
}

type ResultLike<T, E extends TaggedError<string>> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export type { Attributes, AttributeValue, Span, Tracer }
