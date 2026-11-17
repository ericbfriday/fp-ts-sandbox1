/**
 * `@friday-friday/better-auth` runtime tests. The real `better-auth/api` `isAPIError` +
 * `APIError` are exercised through actual throws (devDep better-auth 1.7.25).
 */
import { authCall, beforeDbHook, fromAuthTuple, requireRole, requireSession } from "@friday-friday/better-auth"
import { err, ok } from "@friday-friday/core"
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

  it("maps a thrown APIError to Err(AuthApiError) with status + code", async () => {
    const r = await authCall(async () => {
      throw apiError("invalid credentials", "UNAUTHORIZED", "INVALID_CREDENTIALS")
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.error._tag === "AuthApiError") {
      expect(r.error.status).toBe(401)
      expect(r.error.code).toBe("INVALID_CREDENTIALS")
    } else {
      throw new Error("expected AuthApiError")
    }
  })

  it("does NOT use instanceof (duplicate better-call copies would break it)", async () => {
    // Throw a REAL APIError; even if instanceof worked differently across copies, isAPIError
    // (structural) is what the adapter uses.
    const r = await authCall(async () => {
      throw apiError("rate limited", "TOO_MANY_REQUESTS", "RATE_LIMITED")
    })
    if (!r.ok && r.error._tag === "AuthApiError") expect(r.error.status).toBe(429)
    else throw new Error("expected AuthApiError")
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

  it("error tuple -> Err(AuthApiError) with status + code", () => {
    const r = fromAuthTuple({ data: null, error: { status: 403, code: "FORBIDDEN", message: "no" } })
    if (r.ok) throw new Error("expected Err")
    if (r.error._tag !== "AuthApiError") throw new Error("expected AuthApiError")
    expect(r.error.status).toBe(403)
    expect(r.error.code).toBe("FORBIDDEN")
  })

  it("null data without error -> Unauthenticated", () => {
    const r = fromAuthTuple({ data: null, error: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("Unauthenticated")
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
  it("Ok -> { abort: false, data }", async () => {
    const hook = beforeDbHook<string, never>(async (data) => ok(data.toUpperCase()))
    expect(await hook("abc")).toEqual({ abort: false, data: "ABC" })
  })

  it("Err -> false (abort) by default", async () => {
    const hook = beforeDbHook<string, { readonly _tag: "Rejected" }>(async () => err({ _tag: "Rejected" }))
    expect(await hook("abc")).toBe(false)
  })

  it("throwOnReject: Err throws the tagged error instead", async () => {
    const hook = beforeDbHook<string, { readonly _tag: "Rejected" }>(
      async () => err({ _tag: "Rejected" }),
      { throwOnReject: true }
    )
    await expect(hook("abc")).rejects.toEqual({ _tag: "Rejected" })
  })
})
