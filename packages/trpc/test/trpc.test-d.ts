/**
 * `@friday-friday/trpc` type tests — pins the DECLARED-error contract of `fromTRPC`
 * (tRPC types the formatter shape globally, not per procedure — report §5.3 design limit)
 * and the dual-channel procedure shapes.
 */
import { type Result, taggedError } from "@friday-friday/core"
import type { WireError } from "@friday-friday/core/wire"
import { errorFormatter, fromTRPC, resultMiddleware, type TRPCTransportError } from "@friday-friday/trpc"
import { type AnyTRPCMiddlewareFunction, initTRPC, type TRPCError } from "@trpc/server"
import { describe, expectTypeOf, it } from "vitest"

const NotFound = taggedError("NotFound")<{ id: string }>()
const Conflict = taggedError("Conflict")<{ field: string }>()

type NotFoundE = ReturnType<typeof NotFound>
type ConflictE = ReturnType<typeof Conflict>

describe("fromTRPC declared-error contract", () => {
  it("declared union survives the bridge (AsyncResult<T, E | TRPCTransportError>)", async () => {
    const r = fromTRPC<{ id: string; name: string }, NotFoundE | ConflictE>(
      Promise.resolve({ id: "1", name: "ada" })
    )
    const awaited = await r
    // The annotated const IS the contract pin: the bridge resolves to exactly this Result.
    const _pin: Result<{ id: string; name: string }, NotFoundE | ConflictE | TRPCTransportError> = awaited
    if (!awaited.ok) {
      expectTypeOf(awaited.error._tag).toEqualTypeOf<"NotFound" | "Conflict" | "TRPCTransportError">()
    } else {
      expectTypeOf(awaited.value).toEqualTypeOf<{ id: string; name: string }>()
    }
  })

  it("default E is TRPCTransportError", async () => {
    const r = fromTRPC<string>(Promise.resolve("v"))
    const awaited = await r
    if (!awaited.ok) expectTypeOf(awaited.error._tag).toEqualTypeOf<"TRPCTransportError">()
  })

  it("accepts PromiseLike (tRPC's TRPCTaggedPromise)", async () => {
    // A real Promise IS a PromiseLike; the point is fromTRPC's parameter type.
    const tagged: PromiseLike<number> = Promise.resolve(1)
    const r = fromTRPC<number, NotFoundE>(tagged)
    const awaited = await r
    if (awaited.ok) expectTypeOf(awaited.value).toEqualTypeOf<number>()
    else expectTypeOf(awaited.error._tag).toEqualTypeOf<"NotFound" | "TRPCTransportError">()
  })
})

describe("errorFormatter shape (data.friday_friday, RFC-0001 §7 naming)", () => {
  it("adds friday_friday: WireError | null to tRPC's shape and keeps the shape's own members", () => {
    const format = errorFormatter({ report: () => undefined })
    type Shape = ReturnType<typeof format<{ message: string; code: number; data: { code: string } }>>
    expectTypeOf<Shape["data"]["friday_friday"]>().toEqualTypeOf<WireError | null>()
    expectTypeOf<Shape["data"]["code"]>().toEqualTypeOf<string>()
    expectTypeOf<Shape["code"]>().toEqualTypeOf<number>()
  })

  it("plugs into initTRPC.create", () => {
    const t = initTRPC.create({ errorFormatter: errorFormatter() })
    expectTypeOf(t.router({})).not.toBeAny()
  })
})

describe("resultMiddleware public type (#57: stable @trpc/server entry points only)", () => {
  it("is exactly tRPC's stable root AnyTRPCMiddlewareFunction (not any, not an unstable-core type)", () => {
    expectTypeOf(resultMiddleware({ NotFound: "NOT_FOUND" })).toEqualTypeOf<AnyTRPCMiddlewareFunction>()
  })

  it("map values are exactly TRPCError's code union (derived from the stable root class)", () => {
    expectTypeOf(resultMiddleware).parameter(0).toEqualTypeOf<{ readonly [tag: string]: TRPCError["code"] }>()
    // @ts-expect-error -- not a tRPC error code
    resultMiddleware({ NotFound: "NOPE" })
  })

  it("plugs into procedure.use()", () => {
    const t = initTRPC.create()
    const domain = t.procedure.use(resultMiddleware({ NotFound: "NOT_FOUND" }))
    const router = t.router({ ping: domain.query(() => "pong") })
    expectTypeOf(router.ping).not.toBeAny()
  })
})
