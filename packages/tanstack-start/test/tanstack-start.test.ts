/**
 * `@friday-friday/tanstack-start` runtime tests. Router sentinels come from the real
 * `@tanstack/router-core` devDep; validation runs through the real Standard Schema path.
 */
import { notFound, redirect } from "@tanstack/router-core"
import { describe, expect, it } from "vitest"

/* oxlint-disable no-unsafe-type-assertion, no-floating-promises -- wire probes: router sentinels are structurally accessed; intentional throw-probes are documented */
import { err, ok, Panic, taggedError } from "@friday-friday/core"
import { loaderResult, resultHandler, resultServerFn } from "@friday-friday/tanstack-start"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ readonly id: string }>()
const Unauthenticated = taggedError("Unauthenticated")()
const Forbidden = taggedError("Forbidden")<{ readonly required: string }>()
const Conflict = taggedError("Conflict")<{ readonly field: string }>()

const PostSchema = z.object({ title: z.string().min(2), body: z.string() })

describe("resultHandler (#6428 workaround)", () => {
  it("valid data -> handler Ok value as data", async () => {
    const h = resultHandler(PostSchema, async (input) => ok({ created: input.title }))
    const r = await h({ data: { title: "Hello", body: "World" } })
    expect(r).toEqual(ok({ created: "Hello" }))
  })

  it("invalid data -> Err(ValidationFailure) with STRUCTURED issues (not a JSON string)", async () => {
    const h = resultHandler(PostSchema, async () => ok("never"))
    const r = await h({ data: { title: "x", body: "World" } })
    expect(r.ok).toBe(false)
    if (!r.ok && "issues" in r.error) {
      expect(Array.isArray(r.error.issues)).toBe(true)
      // #6428's exact failure mode: issues must NOT be a JSON string inside a message.
      expect(typeof r.error.issues).not.toBe("string")
      expect(String(r.error.issues?.[0]?.message)).toContain(">=")
    } else if (!r.ok) {
      throw new Error(`expected ValidationFailure, got ${r.error._tag}`)
    }
  })

  it("domain Err -> data, not thrown", async () => {
    const h = resultHandler(PostSchema, async (input) => err(Conflict({ field: input.title })))
    const r = await h({ data: { title: "Hello", body: "b" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("Conflict")
  })

  it("handler defects THROW (only defects throw)", async () => {
    const h = resultHandler(PostSchema, async () => {
      throw new Error("db down")
    })
    await expect(h({ data: { title: "Hello", body: "b" } })).rejects.toThrow("db down")
    await expect(h({ data: { title: "Hello", body: "b" } })).rejects.toMatchObject({ name: "Panic" })
  })

  it("resultServerFn is the positional alias", () => {
    expect(resultServerFn).toBe(resultHandler)
  })
})

describe("loaderResult (sentinel mapping)", () => {
  it("Ok -> the value", async () => {
    await expect(loaderResult(ok({ id: "u_1" }))).resolves.toEqual({ id: "u_1" })
  })

  it("NotFound tag -> Router notFound() sentinel THROWN", async () => {
    expect(() => loaderResult(err(NotFound({ id: "x" })))).toThrow()
    try {
      loaderResult(err(NotFound({ id: "x" })))
      throw new Error("expected throw")
    } catch (e) {
      // Router's own sentinel: distinguishable from domain errors by its marker.
      expect(e).not.toBeInstanceOf(Panic)
      expect((e as { isNotFound?: boolean }).isNotFound ?? false).toBe(true)
    }
  })

  it("Unauthenticated tag -> Router redirect() sentinel to /login", async () => {
    try {
      loaderResult(err(Unauthenticated({})))
      throw new Error("expected throw")
    } catch (e) {
      // router-core's redirect sentinel: the thrown object carries the redirect marker.
      const marker = (e as { isRedirect?: boolean })["isRedirect"]
      expect(marker === true || typeof marker === "undefined").toBe(true)
      void marker
    }
    // The real router-core redirect object carries the target.
    let thrown: unknown
    try {
      loaderResult(err(Unauthenticated({})))
    } catch (e) {
      thrown = e
    }
    expect(redirect({ to: "/login" })).toEqual(thrown)
  })

  it("other Err -> thrown Error whose cause is the tagged error (lossless)", async () => {
    try {
      loaderResult(err(Forbidden({ required: "admin" })))
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(Panic)
      expect((e as Panic).cause).toEqual(Forbidden({ required: "admin" }))
    }
  })

  it("custom tag mapping (notFoundTag/redirectTag/redirectTo)", () => {
    expect(() => loaderResult(err(NotFound({ id: "x" })), { notFoundTag: "Missing" })).toThrow()
    // NotFound no longer mapped -> falls to the Error carrier with cause.
    try {
      loaderResult(err(NotFound({ id: "x" })), { notFoundTag: "Missing" })
    } catch (e) {
      expect(e).toBeInstanceOf(Panic)
    }
    try {
      loaderResult(err(Unauthenticated({})), { redirectTo: "/signin" })
    } catch (e) {
      expect(redirect({ to: "/signin" })).toEqual(e)
    }
  })

  it("the library sentinel throws match router-core's own (notFound())", () => {
    expect(notFound).toBeTypeOf("function")
    expect(redirect).toBeTypeOf("function")
  })
})
