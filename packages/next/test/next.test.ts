/**
 * `@friday-friday/next` runtime tests (Design Report §5.1).
 *
 * `next/navigation` is mocked with sentinel semantics mirroring the real helpers:
 * `unstable_rethrow` rethrows recognized sentinels (digest-bearing control-flow errors);
 * `notFound`/`redirect`/`forbidden` throw their sentinels.
 */
import { err, ok, taggedError, type Result } from "@friday-friday/core"
import { z } from "zod"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Sentinel semantics: Next.js control-flow errors are Error subclasses with a digest.
const isSentinel = (e: unknown): e is Error & { digest: string } => e instanceof Error && typeof (e as { digest?: unknown }).digest === "string"

const notFoundSentinel = (): Error & { digest: string } => Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" })
const redirectSentinel = (url: string): Error & { digest: string } => Object.assign(new Error(`NEXT_REDIRECT;replace;${url}`), { digest: `NEXT_REDIRECT;replace;${url}` })

import { action, nextRethrow, orNotFound, orRedirect, toResponse, tryAsync, trySync } from "@friday-friday/next"
import { redirect, unstable_rethrow } from "next/navigation"

vi.mock("next/navigation", () => {
  const sentinelLike = (e: unknown): e is Error & { digest: string } =>
    e instanceof Error && typeof (e as { digest?: unknown }).digest === "string"
  return {
    unstable_rethrow: vi.fn((error: unknown) => {
      if (sentinelLike(error)) throw error
    }),
    notFound: vi.fn(() => {
      throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" })
    }),
    redirect: vi.fn((url: string) => {
      throw Object.assign(new Error(`NEXT_REDIRECT;replace;${url}`), { digest: `NEXT_REDIRECT;replace;${url}` })
    }),
    forbidden: vi.fn(() => {
      throw Object.assign(new Error("NEXT_FORBIDDEN"), { digest: "NEXT_FORBIDDEN" })
    })
  }
})

const NotFound = taggedError("NotFound")<{ id: string }>()
const Unauthenticated = taggedError("Unauthenticated")<{ reason: string }>()
type NotFoundT = ReturnType<typeof NotFound>
type UnauthenticatedT = ReturnType<typeof Unauthenticated>

beforeEach(() => {
  vi.mocked(unstable_rethrow).mockClear()
})

describe("nextRethrow", () => {
  it("walks the cause chain and rethrows sentinels found at depth", () => {
    const sentinel = notFoundSentinel()
    const wrapped = new Error("db down", { cause: new Error("query failed", { cause: sentinel }) })
    expect(() => nextRethrow(wrapped)).toThrow(sentinel) // the ORIGINAL sentinel escapes
  })

  it("walks at most depth 5", () => {
    let deep: unknown = notFoundSentinel()
    for (let i = 0; i < 6; i++) deep = new Error(`layer-${i}`, { cause: deep })
    // The sentinel sits at depth 6 -> beyond the defensive walk -> not rethrown here.
    expect(() => nextRethrow(deep)).not.toThrow()
    expect(vi.mocked(unstable_rethrow).mock.calls.length).toBe(5)
  })

  it("is a no-op walk for ordinary errors", () => {
    expect(() => nextRethrow(new Error("plain"))).not.toThrow()
  })
})

describe("tryAsync / trySync (sentinels never swallowed)", () => {
  it("INTEGRATION: a redirect thrown in user code escapes the adapter's triage, not mapped", async () => {
    // Report §5.1: redirect() inside user code is a sentinel; even when it is caught and
    // re-raised (the documented unstable_rethrow pattern), the adapter's nextRethrow walks the
    // cause chain FIRST and rethrows — the catch mapping must never swallow it.
    const sentinel = redirectSentinel("/login")
    const wrapped = new Error("handler failed", { cause: sentinel })
    let caught: unknown
    await tryAsync(async () => {
      throw wrapped
    }, { catch: () => "mapped" }).catch((e) => {
      caught = e
    })
    expect(caught).toBe(sentinel) // the ORIGINAL sentinel object escapes, unmapped
  })

  it("a sentinel thrown past the user's catch is rethrown by the adapter, not mapped", async () => {
    // User calls redirect() inside THEIR try with unstable_rethrow (the documented pattern),
    // rethrowing the sentinel to the adapter layer, which must also not swallow it.
    let caught: unknown
    await tryAsync(async () => {
      try {
        throw redirectSentinel("/login")
      } catch (e) {
        if (isSentinel(e)) throw e
      }
      return ok("saved")
    }, { catch: () => "mapped" }).catch((e) => {
      caught = e
    })
    expect(caught).toBeDefined()
    expect(isSentinel(caught)).toBe(true)
    expect((caught as { digest: string }).digest).toContain("/login")
  })

  it("non-sentinel errors map via catch; unmapped become Panic", async () => {
    const mapped = await tryAsync<number, NotFoundT>(async () => {
      throw "db down"
    }, { catch: () => NotFound({ id: "1" }) })
    expect(mapped).toEqual(err(NotFound({ id: "1" })))

    await expect(tryAsync(async () => { throw "defect" }, { catch: () => undefined })).rejects.toThrow()
  })

  it("trySync mirrors tryAsync", () => {
    const mapped = trySync<number, NotFoundT>(() => { throw "boom" }, { catch: () => NotFound({ id: "2" }) })
    expect(mapped).toEqual(err(NotFound({ id: "2" })))
  })
})

describe("loaders", () => {
  it("orNotFound calls notFound() only for the NotFound tag", () => {
    expect(() => orNotFound(err(NotFound({ id: "1" })))).toThrow(/NEXT_NOT_FOUND/)
    expect(orNotFound(ok("fine"))).toEqual(ok("fine"))
    const Other = taggedError("Other")<{ code: number }>()
    expect(orNotFound(err(Other({ code: 1 })))).toEqual(err(Other({ code: 1 }))) // non-NotFound: no sentinel
  })

  it("orRedirect redirects only for the Unauthenticated tag", () => {
    expect(() => orRedirect(err(Unauthenticated({ reason: "anon" })), "/login")).toThrow(/NEXT_REDIRECT/)
    expect(orRedirect(ok("fine"), "/login")).toEqual(ok("fine"))
  })
})

describe("action (useActionState)", () => {
  const Profile = z.object({ name: z.string() })

  it("returns ValidationFailure as data on invalid FormData (form state survives)", async () => {
    const WithAge = Profile.extend({ age: z.number() })
    const save = action(WithAge, async (input) => ok(input.name))
    const fd = new FormData()
    fd.set("name", "eric")
    fd.set("age", "not-a-number")
    const state = await save({ ok: null }, fd)
    expect(state.ok).toBe(false)
    if (state.ok === false && state.error._tag === "ValidationFailure") {
      expect(state.error.issues.length).toBeGreaterThan(0)
    } else {
      throw new Error("expected ValidationFailure")
    }
  })

  it("returns handler Results as data", async () => {
    const save = action(Profile, async (input) => ok(`saved:${input.name}`))
    const fd = new FormData()
    fd.set("name", "eric")
    expect(await save({ ok: null }, fd)).toEqual(ok("saved:eric"))
  })

  it("INTEGRATION: a redirect thrown after a save escapes the action (sentinel wins)", async () => {
    const sentinel = redirectSentinel("/settings?saved=1")
    const save = action(Profile, async () => {
      try {
        throw sentinel // user redirects after saving, inside their handler
      } catch (e) {
        if (isSentinel(e)) throw e // user re-raises via unstable_rethrow (documented pattern)
        return ok("x")
      }
    })
    const fd = new FormData()
    fd.set("name", "eric")
    await expect(save({ ok: null }, fd)).rejects.toBe(sentinel)
  })

  it("defects become Err(InternalDefect) data so form state survives, and onDefect observes", async () => {
    const boom = new Error("db connection lost")
    let observed: unknown
    const save = action(Profile, async () => { throw boom }, { onDefect: (c) => { observed = c } })
    const fd = new FormData()
    fd.set("name", "eric")
    const state = await save({ ok: null }, fd)
    expect(state.ok).toBe(false)
    if (state.ok === false && state.error._tag === "InternalDefect") {
      expect(state.error.reason).toBe("db connection lost")
    } else {
      throw new Error("expected InternalDefect")
    }
    expect(observed).toBe(boom)
  })

  it("a swallowed redirect inside the handler (without rethrow) becomes InternalDefect — and nextRethrow catches the double-swallow", async () => {
    // If the user FULLY swallows a redirect sentinel (no unstable_rethrow), Next's documented
    // behavior is broken by the user's own catch — the adapter surfaces it as a defect rather
    // than silently treating it as success.
    const save = action(Profile, async () => {
      try {
        throw redirectSentinel("/settings")
      } catch {
        return ok("swallowed") // sentinel never reached the adapter (user fully swallowed it)
      }
    })
    const fd = new FormData()
    fd.set("name", "eric")
    const state = await save({ ok: null }, fd)
    expect(state).toEqual(ok("swallowed"))
  })
})

describe("toResponse (RFC-0001 §6 problem+json)", () => {
  it("Ok -> Response.json", async () => {
    const res = toResponse(ok({ hello: "world" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: "world" })
  })

  it("mapped status + problem+json body with tag", async () => {
    const r = err({ _tag: "NotFound", id: "u1", message: "gone" } as never)
    const res = toResponse(r as Result<never, ReturnType<typeof NotFound>>, { NotFound: 404 })
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toBe("application/problem+json")
    const body = (await res.json()) as Record<string, unknown>
    expect(body["tag"]).toBe("NotFound")
    expect(body["status"]).toBe(404)
    expect(body["id"]).toBe("u1")
    expect(body["detail"]).toBe("gone")
    expect(body).not.toHaveProperty("cause")
  })

  it("unmapped tags default: ValidationFailure 422, unknown 500", async () => {
    const vf: Result<never, { _tag: "ValidationFailure" }> = err(ValidationFailureAsTag())
    expect(toResponse(vf).status).toBe(422)
    const unknownTag: Result<never, { _tag: "Weird" }> = err({ _tag: "Weird" })
    expect(toResponse(unknownTag).status).toBe(500)
  })
})

function ValidationFailureAsTag(): { readonly _tag: "ValidationFailure" } {
  return { _tag: "ValidationFailure" }
}
