/**
 * `@friday-friday/hono` runtime tests - a real Hono app on the wire (app.request()),
 * covering respond's literal statuses + problem shape, sv's 422 Problem path,
 * onErrorHandler's HTTPException passthrough (headers! - the report's U claim) and the
 * sanitized 500 for unknown throws, plus the http-client round-trip.
 *
 * NOTE (report TS2589 guidance, observed live): respond's status-literal return types hit
 * instantiation-depth limits and degrade inference for LATER generics in the same file -
 * so each concern runs on its own minimal sub-app, sv's validator is built before any
 * respond() appears in the file, and its explicit type args are kept.
 */
import { err, ok, taggedError } from "@friday-friday/core"
import { onErrorHandler, problem, respond, sv } from "@friday-friday/hono"
import { reconstruct } from "@friday-friday/http"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()
const Forbidden = taggedError("Forbidden")<{ required: string }>()
const Teapot = taggedError("Teapot")()

// -- sv validator FIRST (before any respond() instantiations poison this file) --
const itemsValidator = sv<"json", z.ZodObject<{ name: z.ZodString }>>("json", z.object({ name: z.string().min(2) }))
const itemsApp = new Hono()
itemsApp.post("/items", itemsValidator, (c) => {
  const body = c.req.valid("json")
  return c.json({ created: body.name }, 201)
})

// -- respond sub-app (its types are the instantiation-heavy ones) --
const respondApp = new Hono()
respondApp.get("/users/:id", (c) => {
  const id = c.req.param("id")
  const r: ResultLike = id === "missing"
    ? err(NotFound({ id }))
    : id === "nope"
    ? err(Forbidden({ required: "admin" }))
    : ok({ id, name: "ada" })
  return respond(c, r, { NotFound: 404, Forbidden: 403 } as const)
})
respondApp.get("/teapot", (c) => respond(c, err(Teapot({})), { NotFound: 404, Forbidden: 403, Teapot: 418 } as const))

type ResultLike =
  | { readonly ok: true; readonly value: { readonly id: string; readonly name: string } }
  | { readonly ok: false; readonly error: AppError }

type AppError = ReturnType<typeof NotFound> | ReturnType<typeof Forbidden>

// -- onError sub-app --
const errorApp = new Hono()
errorApp.onError(onErrorHandler({ report: () => {} }))
errorApp.get("/boom", () => {
  throw new Error("internal detail: db password=hunter2")
})
errorApp.get("/http-ex", () => {
  const res = new Response("Custom unauthorized body", { status: 401, headers: { "x-custom": "kept" } })
  throw new HTTPException(401, { res })
})

describe("respond + problem", () => {
  it("Ok -> 200 json", async () => {
    const res = await respondApp.request("/users/1")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "1", name: "ada" })
  })

  it("Err -> literal status from StatusMap + RFC 9457 problem body with tag", async () => {
    const res = await respondApp.request("/users/missing")
    expect(res.status).toBe(404)
    // oxlint-disable-next-line no-unsafe-type-assertion -- wire body probe; asserted field-by-field below
    const body = (await res.json()) as Record<string, unknown>
    expect(body["type"]).toBe("about:blank")
    expect(body["title"]).toBe("Not Found")
    expect(body["status"]).toBe(404)
    expect(body["tag"]).toBe("NotFound")
    expect(body["id"]).toBe("missing") // safe props carried through
  })

  it("multiple error tags map to distinct literal statuses", async () => {
    expect((await respondApp.request("/users/nope")).status).toBe(403)
    expect((await respondApp.request("/teapot")).status).toBe(418)
  })

  it("problem() is reconstruct()-lossless (http client round-trip contract)", async () => {
    const res = await respondApp.request("/users/missing")
    // oxlint-disable-next-line no-unsafe-type-assertion -- wire body probe; asserted field-by-field below
    const body = (await res.json()) as Record<string, unknown>
    // oxlint-disable-next-line no-unsafe-type-assertion -- wire body probe; Problem shape verified above
    expect(reconstruct(body as never)).toEqual(NotFound({ id: "missing" }))
  })
})

describe("sv (Standard Schema validation)", () => {
  it("valid body passes and c.req.valid sees the parsed value", async () => {
    const res = await itemsApp.request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "widget" }),
      headers: { "content-type": "application/json" }
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ created: "widget" })
  })

  it("invalid body -> 422 Problem built from issues", async () => {
    const res = await itemsApp.request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { "content-type": "application/json" }
    })
    expect(res.status).toBe(422)
    // oxlint-disable-next-line no-unsafe-type-assertion -- wire body probe; asserted field-by-field below
    const body = (await res.json()) as Record<string, unknown>
    expect(body["tag"]).toBe("ValidationError")
    expect(body["status"]).toBe(422)
    expect(String(body["detail"])).toContain(">=")
    expect(Array.isArray(body["issues"])).toBe(true)
  })
})

describe("onErrorHandler", () => {
  it("HTTPException passes through with its own status AND custom headers (report's U claim)", async () => {
    const res = await errorApp.request("/http-ex")
    expect(res.status).toBe(401)
    expect(res.headers.get("x-custom")).toBe("kept") // headers preserved
    expect(await res.text()).toBe("Custom unauthorized body")
  })

  it("unknown throw -> sanitized 500 Problem; internals never leak", async () => {
    const res = await errorApp.request("/boom")
    expect(res.status).toBe(500)
    // oxlint-disable-next-line no-unsafe-type-assertion -- wire body probe; asserted field-by-field below
    const body = (await res.json()) as Record<string, unknown>
    expect(body["tag"]).toBe("InternalError")
    expect(JSON.stringify(body)).not.toContain("hunter2")
    expect(JSON.stringify(body)).not.toContain("db password")
  })
})

describe("problem() unit", () => {
  it("message becomes detail; cause is dropped", () => {
    const e = NotFound({ id: "z" })
    const p = problem(e, 404)
    expect(p.tag).toBe("NotFound")
    expect(p.type).toBe("about:blank")
    expect("cause" in p).toBe(false)
  })
})
