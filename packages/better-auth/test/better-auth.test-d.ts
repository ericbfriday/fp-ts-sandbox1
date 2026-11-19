/**
 * `@friday-friday/better-auth` type tests.
 */
import {
  authCall,
  type AuthError,
  beforeDbHook,
  Forbidden,
  type Forbidden as ForbiddenT,
  fromAuthTuple,
  requireRole,
  requireSession,
  type SessionLike,
  Unauthenticated
} from "@friday-friday/better-auth"
import {
  type AsyncResult,
  Forbidden as CoreForbidden,
  type Result,
  Unauthenticated as CoreUnauthenticated
} from "@friday-friday/core"
import { describe, expectTypeOf, it } from "vitest"

describe("authCall", () => {
  it("is AsyncResult<T, AuthError>", async () => {
    const r = authCall(async () => 42)
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, AuthError>>()
    const awaited = await r
    if (awaited.ok) expectTypeOf(awaited.value).toEqualTypeOf<number>()
    else expectTypeOf(awaited.error._tag).toEqualTypeOf<"Unauthenticated" | "Forbidden" | "AuthApiError">()
  })
})

describe("fromAuthTuple", () => {
  it("is Result<T, AuthError>", () => {
    const r = fromAuthTuple<{ id: string }>({ data: { id: "u1" }, error: null })
    expectTypeOf(r).toEqualTypeOf<Result<{ id: string }, AuthError>>()
  })
})

describe("requireSession / requireRole", () => {
  it("requireSession is AsyncResult<SessionLike, AuthError>", () => {
    const r = requireSession({ api: { getSession: () => Promise.resolve(null) } }, new Headers())
    expectTypeOf(r).toEqualTypeOf<AsyncResult<SessionLike, AuthError>>()
  })

  it("requireRole is Result<SessionLike, Forbidden>", () => {
    const session: SessionLike = { session: {}, user: { id: "u1", role: "admin" } }
    const r = requireRole("admin")(session)
    expectTypeOf(r).toEqualTypeOf<Result<SessionLike, ForbiddenT>>()
  })
})

describe("beforeDbHook", () => {
  it("matches better-auth's databaseHooks.before contract: false | { data } | void", async () => {
    const hook = beforeDbHook<string, { readonly _tag: "Rejected" }>(async (d) =>
      d.length > 0 ? { ok: true as const, value: d } : { ok: false as const, error: { _tag: "Rejected" } }
    )
    const out = await hook("x")
    expectTypeOf(out).toEqualTypeOf<false | { readonly data: string } | void>()
  })
})

describe("fixed vocabulary (ADR-0005): extension factories of core's tags", () => {
  type Props<F extends (props: never) => unknown> = Parameters<F>[0]

  it("Forbidden's props are a superset of core's, every one optional", () => {
    expectTypeOf<Props<typeof CoreForbidden>>().toExtend<Props<typeof Forbidden>>()
    expectTypeOf<{}>().toExtend<Props<typeof Forbidden>>()
    expectTypeOf<Props<typeof Forbidden>["code"]>().toEqualTypeOf<string | undefined>()
  })

  it("Unauthenticated's props are a superset of core's, every one optional", () => {
    expectTypeOf<Props<typeof CoreUnauthenticated>>().toExtend<Props<typeof Unauthenticated>>()
    expectTypeOf<{}>().toExtend<Props<typeof Unauthenticated>>()
    expectTypeOf<Props<typeof Unauthenticated>["code"]>().toEqualTypeOf<string | undefined>()
  })

  it("same tags as core", () => {
    expectTypeOf(Forbidden.tag).toEqualTypeOf(CoreForbidden.tag)
    expectTypeOf(Unauthenticated.tag).toEqualTypeOf(CoreUnauthenticated.tag)
  })

  it("core's Forbidden.is and better-auth's agree on required", () => {
    const viaCore = (u: unknown) => (CoreForbidden.is(u) ? u.required : null)
    const viaAuth = (u: unknown) => (Forbidden.is(u) ? u.required : null)
    expectTypeOf(viaAuth).returns.toEqualTypeOf<ReturnType<typeof viaCore>>()
    expectTypeOf(viaCore).returns.toEqualTypeOf<string | undefined | null>()
  })

  it("better-auth's errors are core's errors (assignable both ways where props are optional)", () => {
    expectTypeOf<ForbiddenT>().toExtend<CoreForbidden>()
    expectTypeOf<CoreForbidden>().toExtend<ForbiddenT>()
    expectTypeOf<Unauthenticated>().toExtend<CoreUnauthenticated>()
    expectTypeOf<CoreUnauthenticated>().toExtend<Unauthenticated>()
  })
})
