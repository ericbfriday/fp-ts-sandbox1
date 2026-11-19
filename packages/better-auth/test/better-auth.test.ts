/**
 * `@friday-friday/better-auth` runtime tests. The real `better-auth/api` `isAPIError` +
 * `APIError` are exercised through actual throws (devDep better-auth 1.7.25).
 */
import {
  AuthApiError,
  authCall,
  beforeDbHook,
  Forbidden,
  fromAuthTuple,
  requireRole,
  requireSession,
  Unauthenticated
} from "@friday-friday/better-auth"
import {
  err,
  Forbidden as CoreForbidden,
  ok,
  type TaggedError,
  Unauthenticated as CoreUnauthenticated
} from "@friday-friday/core"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { APIError } from "better-auth/api"
import { describe, expect, it } from "vitest"

/** Build a REAL better-call APIError via its public ctor (string status-code form). */
const apiError = (
  message: string,
  status: "UNAUTHORIZED" | "FORBIDDEN" | "TOO_MANY_REQUESTS",
  code?: string
): APIError => (code === undefined ? new APIError(status, { message }) : new APIError(status, { message, code }))

describe("authCall (server lane)", () => {
  it("resolves ok on success", async () => {
    const r = await authCall(async () => "session-data")
    expect(r).toEqual(ok("session-data"))
  })

  it("maps a thrown 401 APIError to Err(Unauthenticated), keeping Better Auth's code", async () => {
    const r = await authCall(async () => {
      throw apiError("invalid credentials", "UNAUTHORIZED", "INVALID_CREDENTIALS")
    })
    expect(r).toEqual(err(Unauthenticated({ code: "INVALID_CREDENTIALS" })))
  })

  it("maps a thrown 403 APIError to Err(Forbidden), keeping Better Auth's code", async () => {
    const r = await authCall(async () => {
      throw apiError("not allowed", "FORBIDDEN", "USER_BANNED")
    })
    expect(r).toEqual(err(Forbidden({ code: "USER_BANNED" })))
  })

  it("maps any other APIError status to Err(AuthApiError) with status + code", async () => {
    const r = await authCall(async () => {
      throw apiError("rate limited", "TOO_MANY_REQUESTS", "RATE_LIMITED")
    })
    expect(r).toEqual(err(AuthApiError({ status: 429, code: "RATE_LIMITED" })))
  })

  it("omits code when Better Auth's body has none", async () => {
    const r = await authCall(async () => {
      throw apiError("no session", "UNAUTHORIZED")
    })
    expect(r).toEqual(err(Unauthenticated({})))
  })

  describe("an APIError from a second module copy (not instanceof the installed APIError)", () => {
    /**
     * Mirrors better-call 1.4.5 `InternalAPIError` (`dist/error.mjs`): a separate class, as a
     * duplicate `better-call` install would load, so `instanceof APIError` is false.
     */
    class SecondCopyAPIError extends Error {
      readonly status: string | number
      readonly statusCode: number
      readonly body: { message?: string; code?: string } | undefined
      readonly headers: Record<string, string> = {}
      constructor(status: string | number, statusCode: number, body?: { message?: string; code?: string }) {
        super(body?.message)
        this.name = "APIError"
        this.status = status
        this.statusCode = statusCode
        this.body = body
      }
    }

    it("is a genuinely separate class", () => {
      expect(new SecondCopyAPIError("UNAUTHORIZED", 401)).not.toBeInstanceOf(APIError)
    })

    it.each(
      [
        ["UNAUTHORIZED", 401, "SESSION_EXPIRED", Unauthenticated({ code: "SESSION_EXPIRED" })],
        ["FORBIDDEN", 403, "USER_BANNED", Forbidden({ code: "USER_BANNED" })],
        ["NOT_FOUND", 404, "USER_NOT_FOUND", AuthApiError({ status: 404, code: "USER_NOT_FOUND" })]
      ] as const
    )("%s (%i) is recognised and normalized", async (status, statusCode, code, expected) => {
      const r = await authCall(async () => {
        throw new SecondCopyAPIError(status, statusCode, { message: "m", code })
      })
      expect(r).toEqual(err(expected))
    })
  })

  it("rethrows non-APIError defects", async () => {
    await expect(
      authCall(async () => {
        throw new Error("db down")
      })
    ).rejects.toThrow("db down")
  })
})

describe("fromAuthTuple (client lane)", () => {
  it("ok tuple -> ok", () => {
    expect(fromAuthTuple({ data: { id: "u1" }, error: null })).toEqual(ok({ id: "u1" }))
  })

  it("401 error tuple -> Err(Unauthenticated) with code", () => {
    const r = fromAuthTuple({ data: null, error: { status: 401, code: "SESSION_EXPIRED", message: "no" } })
    expect(r).toEqual(err(Unauthenticated({ code: "SESSION_EXPIRED" })))
  })

  it("403 error tuple -> Err(Forbidden) with code", () => {
    const r = fromAuthTuple({ data: null, error: { status: 403, code: "FORBIDDEN", message: "no" } })
    expect(r).toEqual(err(Forbidden({ code: "FORBIDDEN" })))
  })

  it("other error tuple -> Err(AuthApiError) with status + code", () => {
    const r = fromAuthTuple({ data: null, error: { status: 422, code: "INVALID_EMAIL", message: "no" } })
    expect(r).toEqual(err(AuthApiError({ status: 422, code: "INVALID_EMAIL" })))
  })

  it("null data without error -> Unauthenticated", () => {
    const r = fromAuthTuple({ data: null, error: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("Unauthenticated")
  })
})

describe("fixed vocabulary (ADR-0005): core's guards recognise what better-auth produces", () => {
  const errorOf = <E>(r: { ok: true } | { ok: false; error: E }): E | undefined => (r.ok ? undefined : r.error)
  const session = (role: string) => ({ session: {}, user: { id: "u1", role } })

  it.each(
    [
      [
        "authCall 401",
        async () => errorOf(await authCall(async () => Promise.reject(apiError("m", "UNAUTHORIZED", "X"))))
      ],
      ["fromAuthTuple 401", () => errorOf(fromAuthTuple({ data: null, error: { status: 401, code: "X" } }))],
      ["fromAuthTuple null data", () => errorOf(fromAuthTuple({ data: null, error: null }))],
      ["requireSession null", async () =>
        errorOf(
          await requireSession({ api: { getSession: async () => null } }, new Headers())
        )]
    ] as const
  )("%s -> core's Unauthenticated.is", async (_, produce) => {
    const e: TaggedError<string> | undefined = await produce()
    expect(CoreUnauthenticated.is(e)).toBe(true)
  })

  it.each(
    [
      [
        "authCall 403",
        async () => errorOf(await authCall(async () => Promise.reject(apiError("m", "FORBIDDEN", "X"))))
      ],
      ["fromAuthTuple 403", () => errorOf(fromAuthTuple({ data: null, error: { status: 403 } }))],
      ["requireRole", () => errorOf(requireRole("admin")(session("editor")))]
    ] as const
  )("%s -> core's Forbidden.is", async (_, produce) => {
    const e: TaggedError<string> | undefined = await produce()
    expect(CoreForbidden.is(e)).toBe(true)
  })

  it("core's Forbidden.is reads the role requireRole names", () => {
    const e = errorOf(requireRole("admin")(session("editor")))
    expect(CoreForbidden.is(e) ? e.required : "not narrowed").toBe("admin")
  })

  it("the factories share core's tags, so either side's guard accepts the other's errors", () => {
    expect([Forbidden.tag, Unauthenticated.tag]).toEqual(["Forbidden", "Unauthenticated"])
    expect(Forbidden.is(CoreForbidden({ required: "admin" }))).toBe(true)
    expect(Unauthenticated.is(CoreUnauthenticated({}))).toBe(true)
  })
})

describe("wire contract (plain data)", () => {
  it("AuthApiError survives JSON round-trip and structuredClone deep-equal", () => {
    const e = AuthApiError({ status: 404, code: "NOT_FOUND" })
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
    expect(structuredClone(e)).toEqual(e)
  })

  it("Unauthenticated survives JSON round-trip", () => {
    const e = Unauthenticated({})
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })
})

describe("requireSession / requireRole", () => {
  const headers = new Headers()
  const auth = (result: unknown) => ({ api: { getSession: () => Promise.resolve(result) } })

  it("requireSession -> Unauthenticated when session is null", async () => {
    const r = await requireSession(auth(null), headers)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("Unauthenticated")
  })

  it("requireSession -> Unauthenticated when getSession throws a 401 APIError", async () => {
    const throwing = {
      api: { getSession: () => Promise.reject(apiError("expired", "UNAUTHORIZED", "SESSION_EXPIRED")) }
    }
    const r = await requireSession(throwing, headers)
    expect(r).toEqual(err(Unauthenticated({ code: "SESSION_EXPIRED" })))
  })

  it("requireSession -> session on success", async () => {
    const session = { session: { token: "t" }, user: { id: "u1", role: "admin" } }
    const r = await requireSession(auth(session), headers)
    expect(r).toEqual(ok(session))
  })

  it("requireRole grants when the role matches", () => {
    const session = { session: {}, user: { id: "u1", role: "admin,editor" } }
    const r = requireRole("admin")(session)
    expect(r).toEqual(ok(session))
  })

  it("requireRole -> Err(Forbidden) naming the required role otherwise", () => {
    const session = { session: {}, user: { id: "u1", role: "editor" } }
    const r = requireRole("admin")(session)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.required).toBe("admin")
  })
})

describe("beforeDbHook (databaseHooks contract)", () => {
  it("Ok -> { data } (replace)", async () => {
    const hook = beforeDbHook<string, never>(async (data) => ok(data.toUpperCase()))
    expect(await hook("abc")).toEqual({ data: "ABC" })
  })

  it("Err -> false (abort) by default", async () => {
    const hook = beforeDbHook<string, { readonly _tag: "Rejected" }>(async () => err({ _tag: "Rejected" }))
    expect(await hook("abc")).toBe(false)
  })

  it("throwOnReject: Err throws a real Better Auth APIError (400, code = the tag) so it is a 4xx, not a 500", async () => {
    const hook = beforeDbHook<string, { readonly _tag: "Rejected"; readonly message: string }>(
      async () => err({ _tag: "Rejected", message: "email domain not allowed" }),
      { throwOnReject: true }
    )
    const thrown: unknown = await hook("abc").then(
      () => undefined,
      (e: unknown) => e
    )
    expect(thrown).toBeInstanceOf(APIError)
    expect(thrown).toMatchObject({
      name: "APIError",
      status: "BAD_REQUEST",
      statusCode: 400,
      body: { code: "Rejected", message: "email domain not allowed" }
    })
  })

  it("throwOnReject: a tagged error without a message still throws a 400 APIError", async () => {
    const hook = beforeDbHook<string, { readonly _tag: "Rejected" }>(
      async () => err({ _tag: "Rejected" }),
      { throwOnReject: true }
    )
    await expect(hook("abc")).rejects.toMatchObject({ name: "APIError", statusCode: 400, body: { code: "Rejected" } })
  })

  it("throwOnReject through a real betterAuth sign-up: the client gets 400 with the tag as code", async () => {
    const auth = betterAuth({
      // Test-only placeholder (in-memory instance, never deployed).
      secret: "test-secret-test-secret-test-secret-0000",
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      databaseHooks: {
        user: {
          create: {
            before: beforeDbHook(async () => err({ _tag: "Rejected", message: "email domain not allowed" }), {
              throwOnReject: true
            })
          }
        }
      }
    })
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: "a@example.com", password: "password1234", name: "A" })
      })
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: "Rejected", message: "email domain not allowed" })
  })
})
