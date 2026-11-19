/**
 * `@friday-friday/next` runtime tests (Design Report §5.1, RFC-0001 §6, IDEA §4.3).
 *
 * No mock of `next/navigation`: every sentinel here is one the REAL `redirect()` / `notFound()`
 * threw, and it is recognised by its `digest` (the field Next's boundaries and
 * `unstable_rethrow` read), never by `message`. The loaders have their own file
 * (loaders.test.ts, including `orForbidden` against the real `forbidden()`).
 */
import { err, ok, type Result, taggedError } from "@friday-friday/core"
import { mapAsync } from "@friday-friday/core/async"
import { goldenProblems } from "@friday-friday/core/test/wire-golden"
import { fromWire, PROBLEM_CONTENT_TYPE } from "@friday-friday/core/wire"
import { action, nextRethrow, toResponse, tryAsync, trySync } from "@friday-friday/next"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { notFound, redirect, unstable_rethrow } from "next/navigation"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundT = ReturnType<typeof NotFound>

/** Whatever `fn` throws (a real Next sentinel here); fails the test if it returns. */
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return expect.unreachable("expected a throw")
}

const digestOf = (e: unknown): unknown => typeof e === "object" && e !== null && "digest" in e ? e.digest : undefined

/** A real `redirect()` sentinel. Digest layout: `NEXT_REDIRECT;<type>;<url>;<status>;`. */
const redirectSentinel = (url: string): unknown => thrownBy(() => redirect(url))
const notFoundSentinel = (): unknown => thrownBy(() => notFound())

/** `redirect()`'s target, read from the digest the way Next reads it. */
const redirectTarget = (e: unknown): string | undefined => {
  const d = digestOf(e)
  return typeof d === "string" && d.startsWith("NEXT_REDIRECT;") ? d.split(";").slice(2, -2).join(";") : undefined
}

const formData = (entries: ReadonlyArray<readonly [string, string]>): FormData => {
  const fd = new FormData()
  for (const [k, v] of entries) fd.append(k, v)
  return fd
}

describe("real sentinels (fixture sanity)", () => {
  it("are recognised by digest, not message", () => {
    expect(digestOf(notFoundSentinel())).toBe("NEXT_HTTP_ERROR_FALLBACK;404")
    expect(redirectTarget(redirectSentinel("/login"))).toBe("/login")
  })
})

describe("nextRethrow", () => {
  it("rethrows the ORIGINAL sentinel found down an Error cause chain", () => {
    const sentinel = notFoundSentinel()
    const wrapped = new Error("db down", { cause: new Error("query failed", { cause: sentinel }) })
    expect(thrownBy(() => nextRethrow(wrapped))).toBe(sentinel)
  })

  it("walks non-Error links too (which Next's own unstable_rethrow does not)", () => {
    const sentinel = redirectSentinel("/login")
    const wrapped = { cause: { cause: sentinel } }
    expect(() => unstable_rethrow(wrapped)).not.toThrow() // Next alone misses it
    expect(thrownBy(() => nextRethrow(wrapped))).toBe(sentinel)
  })

  it("walks at most depth 5", () => {
    const wrap = (layers: number): unknown => {
      let c: unknown = notFoundSentinel()
      for (let i = 0; i < layers; i++) c = { cause: c }
      return c
    }
    expect(digestOf(thrownBy(() => nextRethrow(wrap(4))))).toBe("NEXT_HTTP_ERROR_FALLBACK;404") // 5th link
    expect(() => nextRethrow(wrap(5))).not.toThrow() // 6th link: beyond the defensive walk
  })

  it("is a no-op for ordinary errors", () => {
    expect(() => nextRethrow(new Error("plain"))).not.toThrow()
    expect(() => nextRethrow("plain")).not.toThrow()
  })
})

describe("tryAsync / trySync (sentinels never swallowed)", () => {
  it("a redirect thrown in user code escapes the triage unmapped, even when wrapped", async () => {
    const sentinel = redirectSentinel("/login")
    const wrapped = new Error("handler failed", { cause: sentinel })
    await expect(tryAsync(async () => {
      throw wrapped
    }, { catch: () => "mapped" })).rejects.toBe(sentinel)
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
    expect(trySync<number, NotFoundT>(() => {
      throw "boom"
    }, { catch: () => NotFound({ id: "2" }) })).toEqual(err(NotFound({ id: "2" })))
    const sentinel = notFoundSentinel()
    expect(thrownBy(() =>
      trySync(() => {
        throw sentinel
      }, { catch: () => "mapped" })
    )).toBe(sentinel)
  })
})

describe("action (useActionState)", () => {
  const Profile = z.object({ name: z.string(), age: z.coerce.number() })
  const valid = (): FormData => formData([["name", "eric"], ["age", "30"]])

  it("returns ValidationFailure as data on invalid FormData (form state survives)", async () => {
    const save = action(Profile, async (input) => ok(`${input.name}/${input.age}`))
    const state = await save({ ok: null }, formData([["name", "eric"], ["age", "not-a-number"]]))
    expect(state.ok === false && state.error._tag === "ValidationFailure" ? state.error.issues : undefined)
      .toEqual([{ message: expect.any(String), path: ["age"] }])
  })

  it("returns handler Results as data", async () => {
    const save = action(Profile, async (input) => ok(`saved:${input.name}`))
    expect(await save({ ok: null }, valid())).toEqual(ok("saved:eric"))
  })

  it("a redirect re-raised by the handler via unstable_rethrow escapes the action", async () => {
    let sentinel: unknown
    const save = action(Profile, async () => {
      try {
        redirect("/settings?saved=1")
      } catch (e) {
        sentinel = e
        unstable_rethrow(e) // the documented user pattern
      }
      return ok("x")
    })
    await expect(save({ ok: null }, valid())).rejects.toSatisfy((e) =>
      e === sentinel && redirectTarget(e) === "/settings?saved=1"
    )
  })

  it("a redirect thrown inside mapAsync (which wraps it in Panic) still escapes the action", async () => {
    const save = action(Profile, (input) =>
      mapAsync(Promise.resolve(ok(input.name)), (name) => {
        redirect(`/profile/saved?name=${name}`)
      }))
    await expect(save({ ok: null }, valid())).rejects.toSatisfy((e) => redirectTarget(e) === "/profile/saved?name=eric")
  })

  it("notFound() thrown inside mapAsync escapes too", async () => {
    const save = action(Profile, () =>
      mapAsync(Promise.resolve(ok(1)), () => {
        notFound()
      }))
    await expect(save({ ok: null }, valid())).rejects.toSatisfy((e) => digestOf(e) === "NEXT_HTTP_ERROR_FALLBACK;404")
  })

  it("a defect returns the fixed InternalDefect envelope; the original goes only to onDefect", async () => {
    const boom = new Error("connect ECONNREFUSED postgres://admin:hunter2@db:5432")
    const observed: Array<unknown> = []
    const save = action(Profile, async () => {
      throw boom
    }, { onDefect: (c) => observed.push(c) })
    const state = await save({ ok: null }, valid())
    expect(state).toEqual(err({ _tag: "InternalDefect", message: "Internal server error" }))
    expect(JSON.stringify(state)).not.toContain("hunter2")
    expect(observed).toEqual([boom])
  })

  it("a throwing onDefect cannot turn the envelope into a crash", async () => {
    const save = action(Profile, async () => {
      throw new Error("db down")
    }, {
      onDefect: () => {
        throw new Error("logger down")
      }
    })
    expect(await save({ ok: null }, valid())).toEqual(err({ _tag: "InternalDefect", message: "Internal server error" }))
  })

  it("an async-refining schema validates inside the triage: Err(ValidationFailure), never a throw", async () => {
    const Async = z.object({ name: z.string().refine(async (n) => n !== "taken", "name is taken") })
    const save = action(Async, async (input) => ok(input.name))
    expect(await save({ ok: null }, formData([["name", "taken"]]))).toEqual(
      err({ _tag: "ValidationFailure", issues: [{ message: "name is taken", path: ["name"] }] })
    )
    expect(await save({ ok: null }, formData([["name", "free"]]))).toEqual(ok("free"))
  })

  it("a vendor validate that throws is a defect: the envelope, reported, form state kept", async () => {
    const vendorBug = new Error("vendor bug")
    const Broken: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw vendorBug
        }
      }
    }
    const observed: Array<unknown> = []
    const save = action(Broken, async (input) => ok(input), { onDefect: (c) => observed.push(c) })
    expect(await save({ ok: null }, valid())).toEqual(err({ _tag: "InternalDefect", message: "Internal server error" }))
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ name: "Panic", cause: vendorBug })
  })

  it("repeated FormData keys reach the schema as arrays; single keys stay scalars", async () => {
    const Tagged = z.object({ name: z.string(), tags: z.array(z.string()) })
    const save = action(Tagged, async (input) => ok(input))
    expect(await save({ ok: null }, formData([["name", "eric"], ["tags", "a"], ["tags", "b"]]))).toEqual(
      ok({ name: "eric", tags: ["a", "b"] })
    )
    // One value is a scalar: a field that may repeat must accept both (documented on `action`).
    const one = await save({ ok: null }, formData([["name", "eric"], ["tags", "a"]]))
    expect(one.ok === false && one.error._tag === "ValidationFailure" ? one.error.issues[0]?.path : undefined)
      .toEqual(["tags"])
  })

  it("a `__proto__` field is an own data property, never the input's prototype", async () => {
    let seen: unknown
    const Spy: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          seen = value
          return { value }
        }
      }
    }
    const save = action(Spy, async () => ok(null))
    await save({ ok: null }, formData([["__proto__", "a"], ["__proto__", "b"]]))
    expect(Object.getPrototypeOf(seen)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(seen, "__proto__")?.value).toEqual(["a", "b"])
  })
})

describe("toResponse (RFC-0001 §6 problem+json via core/wire)", () => {
  it("Ok -> Response.json", async () => {
    const res = toResponse(ok({ hello: "world" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: "world" })
  })

  // Every golden body the next interface can express (status map or defaults, no extra options).
  const expressible = goldenProblems.filter((g) => typeof g.status !== "number" && g.options === undefined)

  it.each(expressible.map((g) => [g.name, g] as const))("golden: %s", async (_name, g) => {
    const res = toResponse(err(g.error), typeof g.status === "number" ? undefined : g.status)
    expect(res.status).toBe(g.body.status)
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE)
    expect(await res.json()).toEqual(g.body)
  })

  it("covers the goldens (the filter didn't silently drop them all)", () => {
    expect(expressible.length).toBeGreaterThanOrEqual(3)
  })

  it("a `status` prop can't overwrite the HTTP status: it is carried in `shadowed` and parses back", async () => {
    const authError = { _tag: "AuthApiError", status: 401, message: "session expired" } as const
    const res = toResponse(err(authError), { AuthApiError: 401 })
    const body: unknown = await res.json()
    expect(res.status).toBe(401)
    expect(body).toMatchObject({ status: 401, shadowed: { status: 401 } })
    const forbidden = toResponse(err(authError), { AuthApiError: 403 })
    const forbiddenBody: unknown = await forbidden.json()
    expect(forbidden.status).toBe(403)
    expect(forbiddenBody).toMatchObject({ status: 403, shadowed: { status: 401 } })
    expect(fromWire(forbiddenBody)).toEqual(authError)
  })

  it("an unmapped tag is a defect: 500 InternalDefect body, original only to onDefect", async () => {
    const observed: Array<unknown> = []
    const leaky = { _tag: "AuthApiError", status: 401, message: "postgres://admin:hunter2@db" } as const
    const res = toResponse(err(leaky), undefined, { onDefect: (c) => observed.push(c) })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain("hunter2")
    expect(JSON.parse(text)).toEqual({
      type: "https://friday-friday.dev/errors/internal-defect",
      title: "Internal Defect",
      status: 500,
      detail: "Internal server error",
      tag: "InternalDefect"
    })
    expect(observed).toEqual([leaky])
  })

  it("defaults fill gaps: ValidationFailure 422, unknown tag 500", () => {
    const vf: Result<never, { _tag: "ValidationFailure" }> = err({ _tag: "ValidationFailure" })
    expect(toResponse(vf).status).toBe(422)
    const unknownTag: Result<never, { _tag: "Weird" }> = err({ _tag: "Weird" })
    expect(toResponse(unknownTag).status).toBe(500)
  })

  it("non-JSON-safe props and cause never cross (a bigint prop no longer crashes the response)", async () => {
    const res = toResponse(err({ _tag: "Conflict", n: 1n, fn: () => 1, cause: new Error("secret"), field: "email" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      type: "https://friday-friday.dev/errors/conflict",
      title: "Conflict",
      status: 409,
      tag: "Conflict",
      field: "email"
    })
  })
})
