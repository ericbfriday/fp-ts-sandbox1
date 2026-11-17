/**
 * `@friday-friday/better-auth` type tests.
 */
import {
  authCall,
  type AuthError,
  beforeDbHook,
  type Forbidden as ForbiddenT,
  fromAuthTuple,
  requireRole,
  requireSession,
  type SessionLike
} from "@friday-friday/better-auth"
import type { AsyncResult, Result } from "@friday-friday/core"
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
