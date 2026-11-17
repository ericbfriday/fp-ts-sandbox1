/**
 * `@friday-friday/otel` runtime tests. Spans are captured through an in-memory Tracer
 * double injected via `opts.tracer` (the helper's injection point). With no SDK the
 * global tracer degrades to no-op spans, which the API guarantees — the provider-less
 * fallback test exercises that path.
 */
import { Panic, taggedError } from "@friday-friday/core"
import { type Span, type SpanOptions, SpanStatusCode, type Tracer } from "@opentelemetry/api"
import { describe, expect, it } from "vitest"

/* oxlint-disable no-unsafe-type-assertion -- test double: every cast below shapes the OTel Tracer/Span interfaces deliberately */
import { traced, tracedSync } from "@friday-friday/otel"

const NotFound = taggedError("NotFound")<{ id: string }>()

interface RecordedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
  status: { code: SpanStatusCode }
  readonly events: Array<{ name: string; attributes?: Record<string, unknown> }>
  ended: boolean
  setStatus(s: { code: SpanStatusCode }): void
  setAttribute(key: string, value: unknown): void
  recordException(e: unknown): void
  end(): void
}

const recorded: Array<RecordedSpan> = []

const makeSpan = (name: string, o?: SpanOptions): RecordedSpan => {
  const span = {
    name,
    attributes: { ...(o?.attributes) },
    status: { code: SpanStatusCode.UNSET } as { code: SpanStatusCode },
    events: [] as Array<{ name: string; attributes?: Record<string, unknown> }>,
    ended: false,
    setStatus(s: { code: SpanStatusCode }) {
      span.status = s
    },
    setAttribute(key: string, value: unknown) {
      span.attributes[key] = value
    },
    recordException(e: unknown) {
      span.events.push({
        name: "exception",
        attributes: { "exception.message": String(e instanceof Error ? e.message : e) }
      })
    },
    end() {
      span.ended = true
    }
  }
  recorded.push(span)
  return span
}

// Overload-style declarations aren't allowed in object literals; one signature + cast.
const fakeTracer = {
  startActiveSpan(
    name: string,
    arg1: SpanOptions | ((span: Span) => unknown),
    arg2?: (span: Span) => unknown
  ): unknown {
    const fn = (arg2 ?? arg1) as (span: Span) => unknown
    const opts = arg2 !== undefined ? (arg1 as SpanOptions) : undefined
    const s = makeSpan(name, opts) as unknown as Span
    return fn(s)
  }
} as Tracer

describe("traced (async)", () => {
  it("Ok -> span ends UNSET, value returned", async () => {
    const r = await traced("users.find", async () => ({ ok: true as const, value: 42 }), { tracer: fakeTracer })
    expect(r).toEqual({ ok: true, value: 42 })
    const s = recorded.at(-1) as RecordedSpan
    expect(s.name).toBe("users.find")
    expect(s.status.code).toBe(SpanStatusCode.UNSET)
    expect(s.ended).toBe(true)
    expect(Object.hasOwn(s.attributes, "fl.error.tag")).toBe(false)
  })

  it("Err -> span status ERROR + fl.error.tag, NO exception event", async () => {
    const r = await traced(
      "users.find",
      async () => ({ ok: false as const, error: NotFound({ id: "x" }) }),
      { tracer: fakeTracer }
    )
    expect(r.ok).toBe(false)
    const s = recorded.at(-1) as RecordedSpan
    expect(s.status.code).toBe(SpanStatusCode.ERROR)
    expect(s.attributes["fl.error.tag"]).toBe("NotFound")
    expect(s.events).toHaveLength(0) // expected errors are NOT recorded as exceptions
  })

  it("defect -> exception recorded + rethrown as-is", async () => {
    const defect = new Panic(new Error("boom"))
    await expect(
      traced("users.find", async () => {
        throw defect
      }, { tracer: fakeTracer })
    ).rejects.toBe(defect)
    const s = recorded.at(-1) as RecordedSpan
    expect(s.status.code).toBe(SpanStatusCode.ERROR)
    expect(s.events[0]?.name).toBe("exception")
    expect(s.ended).toBe(true) // span ends even on the defect path
  })

  it("start attributes are forwarded", async () => {
    await traced("route", async () => ({ ok: true as const, value: 1 }), {
      tracer: fakeTracer,
      attributes: { "http.route": "/users/:id" }
    })
    const s = recorded.at(-1) as RecordedSpan
    expect(s.attributes["http.route"]).toBe("/users/:id")
  })

  it("no tracer option -> falls back to the global tracer without throwing", async () => {
    const r = await traced("global-fallback", async () => ({ ok: true as const, value: "v" }))
    expect(r.ok).toBe(true)
  })
})

describe("tracedSync", () => {
  it("Err -> same ERROR + tag semantics", () => {
    const r = tracedSync("sync.op", () => ({ ok: false as const, error: NotFound({ id: "y" }) }), {
      tracer: fakeTracer
    })
    expect(r.ok).toBe(false)
    const s = recorded.at(-1) as RecordedSpan
    expect(s.status.code).toBe(SpanStatusCode.ERROR)
    expect(s.attributes["fl.error.tag"]).toBe("NotFound")
    expect(s.ended).toBe(true)
  })

  it("defect -> recorded + rethrown", () => {
    const defect = new Panic(new Error("sync boom"))
    expect(() =>
      tracedSync("sync.op", () => {
        throw defect
      }, { tracer: fakeTracer })
    ).toThrow(defect)
    const s = recorded.at(-1) as RecordedSpan
    expect(s.events[0]?.name).toBe("exception")
  })
})
