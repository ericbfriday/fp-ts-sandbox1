/**
 * `@friday-friday/next` runtime tests (Design Report §5.1).
 *
 * `next/navigation` is mocked with sentinel semantics mirroring the real helpers:
 * `unstable_rethrow` rethrows recognized sentinels (digest-bearing control-flow errors);
 * `notFound`/`redirect`/`forbidden` throw their sentinels. The loaders are tested against the
 * real module in loaders.test.ts.
 *
 * The sentinel fixtures use deliberate narrowing assertions (digest-bearing errors with known
 * shapes) \u2014 hence the file-scoped assertion disable.
 */
/* oxlint-disable typescript/no-unsafe-type-assertion -- sentinel fixtures have known shapes */
import { err, ok, type Result, taggedError } from "@friday-friday/core"
const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundT = ReturnType<typeof NotFound>
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

// Sentinel semantics: Next.js control-flow errors are Error subclasses with a digest.
const isSentinel = (e: unknown): e is Error & { digest: string } =>
  e instanceof Error && typeof (e as { digest?: unknown }).digest === "string"

const notFoundSentinel = (): Error & { digest: string } =>
  Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" })
const redirectSentinel = (url: string): Error & { digest: string } =>
  Object.assign(new Error(`NEXT_REDIRECT;replace;${url}`), { digest: `NEXT_REDIRECT;replace;${url}` })

import { action, nextRethrow, toResponse, tryAsync, trySync } from "@friday-friday/next"
import { unstable_rethrow } from "next/navigation"

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
    // cause chain FIRST and rethrows \u2014 the catch mapping must never swallow it.
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

  it("non-sentinel errors map via catch; unmapped become defects", async () => {
    const mapped = await tryAsync<number, NotFoundT>(async () => {
      throw "db down"
    }, { catch: () => NotFound({ id: "1" }) })
    expect(mapped).toEqual(err(NotFound({ id: "1" })))

    await expect(tryAsync(async () => {
      throw "defect"
    }, { catch: () => undefined })).rejects.toThrow()
  })

  it("trySync mirrors tryAsync", () => {
    const mapped = trySync<number, NotFoundT>(() => {
      throw "boom"
    }, { catch: () => NotFound({ id: "2" }) })
    expect(mapped).toEqual(err(NotFound({ id: "2" })))
  })
})

describe("action (useActionState)", () => {
  const Profile = z.object({ name: z.string(), age: z.coerce.number() })

  it("returns ValidationFailure as data on invalid FormData (form state survives)", async () => {
    const save = action(Profile, async (input) => ok(`${input.name}/${input.age}`))
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
    fd.set("age", 30)
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
    fd.set("age", 30)
    await expect(save({ ok: null }, fd)).rejects.toBe(sentinel)
  })

  it("defects become Err(InternalDefect) data so form state survives, and onDefect observes", async () => {
    const boom = new Error("db connection lost")
    let observed: unknown
    const save = action(Profile, async () => {
      throw boom
    }, {
      onDefect: (c) => {
        observed = c
      }
    })
    const fd = new FormData()
    fd.set("name", "eric")
    fd.set("age", 30)
    const state = await save({ ok: null }, fd)
    expect(state.ok).toBe(false)
    if (state.ok === false && state.error._tag === "InternalDefect") {
      expect(state.error.reason).toBe("db connection lost")
    } else {
      throw new Error("expected InternalDefect")
    }
    expect(observed).toBe(boom)
  })
})

describe("toResponse (RFC-0001 §6 problem+json)", () => {
  it("Ok -> Response.json", async () => {
    const res = toResponse(ok({ hello: "world" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: "world" })
  })

  it("mapped status + problem+json body with tag", async () => {
    const r = err({ _tag: "NotFound", id: "u1", message: "gone" })
    const res = toResponse(r, { NotFound: 404 })
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toBe("application/problem+json")
    const body = (await res.json()) as Record<string, unknown>
    expect(body["tag"]).toBe("NotFound")
    expect(body["status"]).toBe(404)
    expect(body["id"]).toBe("u1")
    expect(body["detail"]).toBe("gone")
    expect(body).not.toHaveProperty("cause")
  })

  it("unmapped tags default: ValidationFailure 422, unknown 500", () => {
    const vf: Result<never, { _tag: "ValidationFailure" }> = err({ _tag: "ValidationFailure" })
    expect(toResponse(vf).status).toBe(422)
    const unknownTag: Result<never, { _tag: "Weird" }> = err({ _tag: "Weird" })
    expect(toResponse(unknownTag).status).toBe(500)
  })
})
