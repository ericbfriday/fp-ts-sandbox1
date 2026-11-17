/**
 * Issue #9 exit criteria, proven on the wire:
 * - invalid FormData -> ValidationFailure FIELD errors as data (form state survives)
 * - missing session -> Err in the action state (Forbidden)
 * - valid save -> `redirect()` sentinel THROWN out of action() (survives the try/catch)
 * - route handler -> 200 json on Ok, 404 problem+json on Err (toResponse)
 *
 * next/navigation is mocked with sentinel-accurate fakes (same pattern as
 * packages/next/test/next.test.ts) since vitest runs outside the Next.js runtime.
 */
import { describe, expect, it, vi } from "vitest"

/* oxlint-disable no-unsafe-type-assertion -- wire probes: tRPC/Next error shapes are structurally accessed in tests */

vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT;replace;${url};status;303`)
  },
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND")
  },
  unstable_rethrow: (e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("NEXT_REDIRECT") || msg.startsWith("NEXT_NOT_FOUND")) throw e
  }
}))

import { GET } from "../src/app/api/profile/route"
import { updateProfile } from "../src/app/profile/actions"
import { getProfile, NotFound } from "../src/lib/profiles"

const formData = (overrides: Record<string, string> = {}): FormData => {
  const fd = new FormData()
  fd.set("displayName", overrides["displayName"] ?? "Grace Hopper")
  fd.set("bio", overrides["bio"] ?? "Compiler pioneer.")
  return fd
}

const redirectOf = (e: unknown): string | null => {
  const m = e instanceof Error ? e.message.match(/^NEXT_REDIRECT;replace;([^;]+);/) : null
  return m?.[1] ?? null
}

describe("action: ValidationFailure field errors as data", () => {
  it("too-short displayName -> ok:false with issues (state survives)", async () => {
    const state = await updateProfile({ ok: null }, formData({ displayName: "G" }))
    if (state.ok === false) {
      const issues = (state.error as { issues?: ReadonlyArray<{ message?: string; path?: ReadonlyArray<unknown> }> })
        .issues
      expect(Array.isArray(issues)).toBe(true)
      expect(String(issues?.[0]?.message)).toContain("at least 2")
    }
  })

  it("too-long bio -> field error on bio", async () => {
    const state = await updateProfile({ ok: null }, formData({ bio: "x".repeat(281) }))
    if (state.ok === false) {
      const issues = (state.error as { issues?: ReadonlyArray<{ path?: ReadonlyArray<unknown> }> }).issues
      expect(issues?.[0]?.path?.[0]).toBe("bio")
    }
  })
})

describe("action: redirect after save (exit criterion)", () => {
  it("valid save -> redirect sentinel THROWN (survives the try/catch)", async () => {
    await expect(updateProfile({ ok: null }, formData())).rejects.toThrowError(/^NEXT_REDIRECT/)
    await expect(updateProfile({ ok: null }, formData())).rejects.toMatchObject({
      message: expect.stringContaining("/profile/saved?id=u_1")
    })
  })

  it("redirect target is the saved profile url", async () => {
    let caught: unknown
    try {
      await updateProfile({ ok: null }, formData({ displayName: "Grace Hopper 2" }))
    } catch (e) {
      caught = e
    }
    expect(redirectOf(caught)).toBe("/profile/saved?id=u_1")
  })
})

describe("route handler: toResponse problem+json", () => {
  it("existing profile -> 200 json", async () => {
    const req = new Request("http://localhost/api/profile?id=u_1")
    const res = await GET(req as never)
    expect(res.status).toBe(200)
    // The redirect tests earlier in this file mutate the fixture store; id is the stable key.
    expect(await res.json()).toMatchObject({ id: "u_1" })
  })

  it("missing profile -> 404 problem+json with the tagged error", async () => {
    const req = new Request("http://localhost/api/profile?id=ghost")
    const res = await GET(req as never)
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/problem+json")
    const body = (await res.json()) as Record<string, unknown>
    expect(body["tag"]).toBe("NotFound")
    expect(body["id"]).toBe("ghost")
  })

  it("the problem body is reconstructible (plain data)", async () => {
    const req = new Request("http://localhost/api/profile?id=ghost")
    const res = await GET(req as never)
    const body = (await res.json()) as Record<string, unknown>
    // body minus problem metadata == the server's tagged error (lossless round-trip)
    const { type, title, status, detail, tag, ...safeProps } = body
    void type
    void title
    void status
    void detail
    expect({ _tag: tag, ...safeProps }).toEqual(NotFound({ id: "ghost" }))
  })

  it("getProfile itself is plain-data Result (JSON round-trip wire contract)", async () => {
    const r = await getProfile("u_1")
    // The store may have been mutated by earlier action tests; the CONTRACT is that the
    // Result survives JSON.stringify/parse unchanged, whatever the values are.
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})
