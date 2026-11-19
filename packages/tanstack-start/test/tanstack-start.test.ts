/**
 * `@friday-friday/tanstack-start` runtime tests. Router sentinels come from the real
 * `@tanstack/router-core` devDep; validation runs through the real Standard Schema path.
 */
import { isNotFound, isRedirect, notFound, redirect } from "@tanstack/router-core"
import { describe, expect, it } from "vitest"

/* oxlint-disable no-unsafe-type-assertion, no-floating-promises -- wire probes: router sentinels are structurally accessed; intentional throw-probes are documented */
import { Conflict, err, Forbidden, NotFound, ok, Panic, Unauthenticated } from "@friday-friday/core"
import { loaderResult, resultHandler } from "@friday-friday/tanstack-start"
import { z } from "zod"

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

  it("Panic thrown by the handler propagates as the SAME instance (no double-wrap)", async () => {
    const panic = new Panic(new Error("inner"))
    const h = resultHandler(PostSchema, async () => {
      throw panic
    })
    await expect(h({ data: { title: "Hello", body: "b" } })).rejects.toBe(panic)
  })

  it("a non-Error throw becomes Panic with a readable message, original on cause", async () => {
    const thrown = { _tag: "Boom", message: "pool exhausted" }
    const h = resultHandler(PostSchema, async () => {
      throw thrown
    })
    const e: unknown = await h({ data: { title: "Hello", body: "b" } }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Panic)
    expect((e as Panic).message).toBe("Boom: pool exhausted")
    expect((e as Panic).cause).toBe(thrown)
  })

  it("a revoked Proxy thrown by the handler still becomes Panic (sentinel check is total)", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const h = resultHandler(PostSchema, async () => {
      throw proxy
    })
    await expect(h({ data: { title: "Hello", body: "b" } })).rejects.toBeInstanceOf(Panic)
  })
})

describe("resultHandler lets real router-core sentinels through unwrapped", () => {
  const valid = { data: { title: "Hello", body: "b" } }

  it("redirect() thrown in an async handler rejects with the SAME redirect", async () => {
    const sentinel = redirect({ to: "/posts" })
    const h = resultHandler(PostSchema, async () => {
      throw sentinel
    })
    const e: unknown = await h(valid).catch((x: unknown) => x)
    expect(e).toBe(sentinel)
    expect(isRedirect(e)).toBe(true)
    expect(e).not.toBeInstanceOf(Panic)
  })

  it("redirect({ throw: true }) inside the handler propagates unwrapped", async () => {
    const h = resultHandler(PostSchema, async () => {
      redirect({ to: "/login", throw: true }) // router-core throws the Response itself
      return ok("unreachable")
    })
    const e: unknown = await h(valid).catch((x: unknown) => x)
    expect(isRedirect(e)).toBe(true)
    expect(e).not.toBeInstanceOf(Panic)
  })

  it("notFound() thrown in an async handler rejects with the SAME sentinel", async () => {
    const sentinel = notFound()
    const h = resultHandler(PostSchema, async () => {
      throw sentinel
    })
    const e: unknown = await h(valid).catch((x: unknown) => x)
    expect(e).toBe(sentinel)
    expect(isNotFound(e)).toBe(true)
  })

  it("a sentinel thrown synchronously by a non-async handler propagates unwrapped", async () => {
    const sentinel = notFound({ routeId: "/posts/$id" })
    const h = resultHandler(PostSchema, () => {
      throw sentinel
    })
    await expect(h(valid)).rejects.toBe(sentinel)
  })
})

describe("loaderResult (sentinel mapping)", () => {
  it("Ok -> the value", async () => {
    await expect(loaderResult(ok({ id: "u_1" }))).resolves.toEqual({ id: "u_1" })
  })

  it("never throws synchronously: every Err arm is a rejected promise", () => {
    for (const e of [NotFound({ id: "x" }), Unauthenticated({}), Forbidden({ required: "admin" })]) {
      let p: Promise<unknown> | undefined
      expect(() => {
        p = loaderResult(err(e))
      }).not.toThrow()
      expect(p).toBeInstanceOf(Promise)
      p?.catch(() => undefined)
    }
  })

  it("NotFound tag -> rejects with router-core's notFound() sentinel", async () => {
    const e: unknown = await loaderResult(err(NotFound({ id: "x" }))).catch((x: unknown) => x)
    expect(isNotFound(e)).toBe(true)
    expect(e).not.toBeInstanceOf(Panic)
  })

  it("Unauthenticated tag -> rejects with router-core's redirect() to /login", async () => {
    const e: unknown = await loaderResult(err(Unauthenticated({}))).catch((x: unknown) => x)
    expect(isRedirect(e)).toBe(true)
    expect(e).toEqual(redirect({ to: "/login" }))
  })

  it("other Err -> rejects with Panic whose cause is the tagged error (lossless)", async () => {
    const e: unknown = await loaderResult(err(Forbidden({ required: "admin" }))).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Panic)
    expect((e as Panic).cause).toEqual(Forbidden({ required: "admin" }))
  })

  it("Panic message is readable (tag, then message), never [object Object]", async () => {
    const bare: unknown = await loaderResult(err(Forbidden({ required: "admin" }))).catch((x: unknown) => x)
    expect((bare as Panic).message).toBe("Forbidden")
    const withMessage: unknown = await loaderResult(err(Forbidden({ required: "admin", message: "admins only" })))
      .catch((x: unknown) => x)
    expect((withMessage as Panic).message).toBe("Forbidden: admins only")
  })

  it("custom tag mapping (notFoundTag/redirectTag/redirectTo)", async () => {
    const custom: unknown = await loaderResult(err(Forbidden({ required: "admin" })), { notFoundTag: "Forbidden" })
      .catch((x: unknown) => x)
    expect(isNotFound(custom)).toBe(true)
    // NotFound no longer mapped -> falls to the Panic carrier with cause.
    const unmapped: unknown = await loaderResult(err(NotFound({ id: "x" })), { notFoundTag: "Missing" })
      .catch((x: unknown) => x)
    expect(unmapped).toBeInstanceOf(Panic)
    const signin: unknown = await loaderResult(err(Unauthenticated({})), { redirectTo: "/signin" })
      .catch((x: unknown) => x)
    expect(signin).toEqual(redirect({ to: "/signin" }))
    const byTag: unknown = await loaderResult(err(Forbidden({ required: "admin" })), { redirectTag: "Forbidden" })
      .catch((x: unknown) => x)
    expect(isRedirect(byTag)).toBe(true)
  })
})
