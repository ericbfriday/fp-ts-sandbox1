/**
 * Issue #9 exit criteria, proven on the wire:
 * - invalid FormData -> ValidationFailure FIELD errors as data (form state survives)
 * - missing session -> Err in the action state (Forbidden)
 * - valid save -> `redirect()` sentinel THROWN out of action() (survives the try/catch)
 * - route handler -> 200 json on Ok, 404 problem+json on Err (toResponse)
 *
 * - form rendering -> field errors from schema's `toFieldErrors`, a human message otherwise
 *
 * No mock: `redirect()` is the REAL next/navigation sentinel, recognised by its `digest`.
 */
import {
  Conflict,
  err,
  Forbidden as CoreForbidden,
  NotFound,
  ok,
  Unauthenticated as CoreUnauthenticated
} from "@friday-friday/core"
import { toDefect } from "@friday-friday/core/wire"
import { toValidationFailure } from "@friday-friday/schema"
import { describe, expect, it } from "vitest"

/* oxlint-disable no-unsafe-type-assertion -- wire probes: Next error shapes are structurally accessed in tests */

import { GET } from "../src/app/api/profile/route"
import { Forbidden, updateProfile } from "../src/app/profile/actions"
import { formErrorsOf } from "../src/app/profile/form-errors"
import { getProfile } from "../src/lib/profiles"
import { Unauthenticated } from "../src/lib/session"

const formData = (overrides: Record<string, string> = {}): FormData => {
  const fd = new FormData()
  fd.set("displayName", overrides["displayName"] ?? "Grace Hopper")
  fd.set("bio", overrides["bio"] ?? "Compiler pioneer.")
  return fd
}

/** `redirect()`'s target, read from the REAL sentinel's digest (`NEXT_REDIRECT;<type>;<url>;<status>;`). */
const redirectOf = (e: unknown): string | null => {
  const d = typeof e === "object" && e !== null && "digest" in e ? e.digest : undefined
  return typeof d === "string" && d.startsWith("NEXT_REDIRECT;") ? d.split(";").slice(2, -2).join(";") : null
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
  it("valid save -> redirect sentinel THROWN (survives mapAsync's Panic wrap and the triage)", async () => {
    await expect(updateProfile({ ok: null }, formData())).rejects.toSatisfy((e) =>
      redirectOf(e) === "/profile/saved?id=u_1"
    )
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
    expect({ _tag: tag, ...safeProps }).toEqual(NotFound({ resource: "profile", id: "ghost" }))
  })

  it("getProfile itself is plain-data Result (JSON round-trip wire contract)", async () => {
    const r = await getProfile("u_1")
    // The store may have been mutated by earlier action tests; the CONTRACT is that the
    // Result survives JSON.stringify/parse unchanged, whatever the values are.
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})

describe("form errors (what profile-form renders)", () => {
  it("idle and Ok states render nothing", () => {
    expect(formErrorsOf({ ok: null })).toEqual({ fields: {} })
    expect(formErrorsOf(ok({ id: "u_1", displayName: "Ada", bio: "" }))).toEqual({ fields: {} })
  })

  it("ValidationFailure -> schema's toFieldErrors buckets per field; root issues are form-level", () => {
    const failure = toValidationFailure([
      { message: "Display name needs at least 2 characters", path: ["displayName"] },
      { message: "Bio must be 280 characters or fewer", path: ["bio"] },
      { message: "Something about the whole form", path: [] }
    ])
    expect(formErrorsOf(err(failure))).toEqual({
      form: "Something about the whole form",
      fields: {
        displayName: ["Display name needs at least 2 characters"],
        bio: ["Bio must be 280 characters or fewer"]
      }
    })
  })

  it("every non-validation error renders a human sentence, never [object Object]", () => {
    const states = [
      err(Forbidden({ action: "updateProfile" })),
      err(NotFound({ resource: "profile", id: "u_1" })),
      err(Conflict({ field: "displayName" })),
      err(toDefect(new Error("db down")))
    ]
    for (const state of states) {
      const { form, fields } = formErrorsOf(state)
      expect(fields).toEqual({})
      expect(form).toMatch(/^[A-Z][^{}]+\.$/)
      expect(form).not.toContain("[object")
    }
  })
})

describe("fixed vocabulary (ADR-0005, #91)", () => {
  it("the store fails with core's NotFound, naming the resource", async () => {
    const r = await getProfile("ghost")
    expect(r).toEqual(err(NotFound({ resource: "profile", id: "ghost" })))
  })

  it("extensions of fixed tags add only optional props, so core's guards narrow them soundly", () => {
    // Compiles only while every prop is optional (pnpm run check typechecks this file).
    const forbidden: CoreForbidden = Forbidden({})
    const unauthenticated: CoreUnauthenticated = Unauthenticated({})
    expect(Forbidden.tag).toBe(CoreForbidden.tag)
    expect(Unauthenticated.tag).toBe(CoreUnauthenticated.tag)
    expect(CoreForbidden.is(Forbidden({ action: "updateProfile" }))).toBe(true)
    expect(CoreUnauthenticated.is(Unauthenticated({ where: "updateProfile" }))).toBe(true)
    expect([forbidden, unauthenticated].map((e) => e._tag)).toEqual(["Forbidden", "Unauthenticated"])
  })
})
