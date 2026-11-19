/**
 * `@friday-friday/otel` type tests.
 */
import { NotFound, taggedError } from "@friday-friday/core"
import { traced, tracedSync } from "@friday-friday/otel"
import { describe, expectTypeOf, it } from "vitest"

const Boom = taggedError("Boom")<{ reason: string }>()

type NotFoundE = ReturnType<typeof NotFound>
type BoomE = ReturnType<typeof Boom>

describe("traced", () => {
  it("preserves the AsyncResult error channel exactly", async () => {
    const r = traced(
      "op",
      async () =>
        Math.random() >= 0
          ? ({ ok: true as const, value: 1 } as const)
          : ({ ok: false as const, error: NotFound({ id: "x" }) } as const)
    )
    const awaited = await r
    if (awaited.ok) expectTypeOf(awaited.value).toEqualTypeOf<1>()
    else expectTypeOf(awaited.error._tag).toEqualTypeOf<"NotFound">()
  })

  it("union error channel survives tracing", async () => {
    const r = traced<"a" | "b", NotFoundE | BoomE>("op", async () => {
      if (Math.random() >= 0) return { ok: true as const, value: "a" as const }
      return { ok: false as const, error: Boom({ reason: "r" }) }
    })
    const awaited = await r
    if (!awaited.ok) expectTypeOf(awaited.error._tag).toEqualTypeOf<"NotFound" | "Boom">()
  })
})

describe("tracedSync", () => {
  it("preserves the sync Result error channel", () => {
    const r = tracedSync<number, NotFoundE>(
      "op",
      () => Math.random() >= 0 ? { ok: true as const, value: 1 } : { ok: false as const, error: NotFound({ id: "y" }) }
    )
    if (!r.ok) expectTypeOf(r.error._tag).toEqualTypeOf<"NotFound">()
    else expectTypeOf(r.value).toEqualTypeOf<number>()
  })

  it("preserves UNION sync error channels", () => {
    const r = tracedSync<number, NotFoundE | BoomE>("op", () =>
      Math.random() >= 0
        ? { ok: true as const, value: 1 }
        : Math.random() >= 0.5
        ? { ok: false as const, error: NotFound({ id: "y" }) }
        : { ok: false as const, error: Boom({ reason: "r" }) })
    if (!r.ok) expectTypeOf(r.error._tag).toEqualTypeOf<"NotFound" | "Boom">()
  })
})
