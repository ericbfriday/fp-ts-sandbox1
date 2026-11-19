/**
 * `@friday-friday/hono` runtime tests - a real Hono app on the wire (app.request()).
 *
 * The wire rules (sanitize, RFC 9457 body, tag -> status, defect envelope, parse-back) belong to
 * `@friday-friday/core/wire` (#33, decision note 2026-11-17-core-wire-subpath.md); validation
 * issues belong to `@friday-friday/schema` (`toValidationFailure`, #45). These tests assert that
 * hono's HTTP output matches core's golden bodies and parses back with core's real `fromWire`
 * (#37), instead of hand-copied fixtures.
 *
 * NOTE (report TS2589 guidance, observed live): respond's status-literal return types hit
 * instantiation-depth limits and degrade inference for LATER generics in the same file -
 * so each concern runs on its own minimal sub-app, sv's validator is built before any
 * respond() appears in the file, and its explicit type args are kept.
 */
import { err, Forbidden, NotFound, ok, Panic, taggedError } from "@friday-friday/core"
import { goldenProblems } from "@friday-friday/core/test/wire-golden"
import { fromWire, PROBLEM_CONTENT_TYPE } from "@friday-friday/core/wire"
import { onErrorHandler, problem, respond, sv } from "@friday-friday/hono"
import type { StandardSchemaV1 } from "@friday-friday/schema"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const Teapot = taggedError("Teapot")()

const json = async (res: Response): Promise<unknown> => res.json()

// -- sv validators FIRST (before any respond() instantiations poison this file) --
const itemsValidator = sv<"json", z.ZodObject<{ name: z.ZodString }>>("json", z.object({ name: z.string().min(2) }))
const itemsApp = new Hono()
itemsApp.post("/items", itemsValidator, (c) => {
  const body = c.req.valid("json")
  return c.json({ created: body.name }, 201)
})

/**
 * A hand-rolled Standard Schema whose issues look like what some vendors really send: a root
 * issue with NO `path`, a `{ key }` segment, and vendor extras (`input`, `expected`) that must
 * never reach the client (the submitted password).
 */
const passwordSchema: StandardSchemaV1<unknown, { password: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({
      issues: [
        // oxlint-disable-next-line no-unsafe-type-assertion -- vendor extras on purpose: sv must drop them
        { message: "Passwords differ", input: value, expected: "match" } as StandardSchemaV1.Issue,
        // oxlint-disable-next-line no-unsafe-type-assertion -- vendor extras on purpose: sv must drop them
        { message: "Too short", path: [{ key: "password" }], input: "hunter2" } as StandardSchemaV1.Issue
      ]
    })
  }
}
const passwordApp = new Hono()
passwordApp.post("/signup", sv("json", passwordSchema), (c) => c.json({ ok: true }, 201))

/** A vendor whose validate throws: a defect, not a validation failure. */
const throwingSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => {
      throw new Error("vendor exploded: secret=hunter2")
    }
  }
}
const throwingReports: Array<unknown> = []
const throwingApp = new Hono()
throwingApp.onError(onErrorHandler({ report: (cause) => throwingReports.push(cause) }))
throwingApp.post("/x", sv("json", throwingSchema), (c) => c.json({ ok: true }, 201))

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
// A widened E at runtime (cast, or an Err from code the map never saw): the tag isn't in the map.
respondApp.get("/unmapped", (c) =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- deliberately lies about E: the runtime safety net is under test
  respond(c, err(NotFound({ id: "db.internal:5432" })) as ResultLike, { Forbidden: 403 } as never))
respondApp.get("/bigint", (c) =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- a bigint prop the types allow via an untyped payload
  respond(c, err(NotFound({ id: "1", count: 3n } as never)), { NotFound: 404 } as const))

type ResultLike =
  | { readonly ok: true; readonly value: { readonly id: string; readonly name: string } }
  | { readonly ok: false; readonly error: AppError }

type AppError = ReturnType<typeof NotFound> | ReturnType<typeof Forbidden>

// -- golden sub-app: every core golden body, served by respond --
const goldenApp = new Hono()
goldenProblems.forEach((g, i) => {
  // A golden whose body keeps the error's tag was mapped: give respond exactly that status.
  // A masked golden (body tag InternalDefect for another tag) keeps the golden's own map.
  const masked = g.body.tag !== g.error._tag
  const statuses = masked ? (typeof g.status === "object" ? g.status : {}) : { [g.error._tag]: g.body.status }
  // oxlint-disable-next-line no-unsafe-type-assertion -- golden statuses are runtime data; the status-literal typing is tested in hono.test-d.ts
  goldenApp.get(`/g/${i}`, (c) => respond(c, err(g.error), statuses as never))
})

// -- onError sub-app --
const reports: Array<unknown> = []
const boom = new Error("internal detail: db password=hunter2")
const errorApp = new Hono()
errorApp.onError(onErrorHandler({ report: (cause) => reports.push(cause) }))
errorApp.get("/boom", () => {
  throw boom
})
errorApp.get("/panic", () => {
  throw new Panic(new Error("postgres://user:hunter2@db"))
})
errorApp.get("/http-ex", () => {
  const res = new Response("Custom unauthorized body", { status: 401, headers: { "x-custom": "kept" } })
  throw new HTTPException(401, { res })
})
const defaultErrorApp = new Hono()
defaultErrorApp.onError(onErrorHandler())
defaultErrorApp.get("/boom", () => {
  throw boom
})

const defectGolden = goldenProblems.find((g) => g.error._tag === "InternalDefect" && g.status === undefined)
const validationGolden = goldenProblems.find((g) => g.error._tag === "ValidationFailure")

describe("respond", () => {
  it("Ok -> 200 json", async () => {
    const res = await respondApp.request("/users/1")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ id: "1", name: "ada" })
  })

  it("Err -> literal status from the StatusMap, application/problem+json, core's problem body", async () => {
    const res = await respondApp.request("/users/missing")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE)
    expect(await res.json()).toEqual({
      type: "https://friday-friday.dev/errors/not-found",
      title: "Not Found",
      status: 404,
      tag: "NotFound",
      id: "missing"
    })
  })

  it("multiple error tags map to distinct literal statuses", async () => {
    expect((await respondApp.request("/users/nope")).status).toBe(403)
    expect((await respondApp.request("/teapot")).status).toBe(418)
  })

  it("an Err whose tag isn't in the status map is a 500 InternalDefect, never 2xx (#37)", async () => {
    const res = await respondApp.request("/unmapped")
    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE)
    const body = await json(res)
    expect(body).toEqual(defectGolden?.body)
    expect(JSON.stringify(body)).not.toContain("db.internal")
  })

  it("a bigint prop doesn't make serialization throw; it is dropped (#37 repro)", async () => {
    const res = await respondApp.request("/bigint")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      type: "https://friday-friday.dev/errors/not-found",
      title: "Not Found",
      status: 404,
      tag: "NotFound",
      id: "1"
    })
  })

  it("real round-trip: core fromWire rebuilds the tagged error from the HTTP body", async () => {
    const res = await respondApp.request("/users/missing")
    expect(fromWire(await res.json())).toEqual(NotFound({ id: "missing" }))
  })

  it("serves every core golden body over HTTP with its status and the problem content type", async () => {
    expect(goldenProblems.length).toBeGreaterThan(0)
    for (const [i, g] of goldenProblems.entries()) {
      // safeProps allowlists are a toProblem option hono doesn't expose; those goldens are core's.
      if (g.options?.safeProps !== undefined) continue
      const res = await goldenApp.request(`/g/${i}`)
      expect(res.status, g.name).toBe(g.body.status)
      expect(res.headers.get("content-type"), g.name).toBe(PROBLEM_CONTENT_TYPE)
      expect(await res.json(), g.name).toEqual(g.body)
    }
  })
})

describe("problem()", () => {
  it("equals core's golden body for every golden built from an explicit status", () => {
    let checked = 0
    for (const g of goldenProblems) {
      if (typeof g.status !== "number" || g.options !== undefined) continue
      expect(problem(g.error, g.status), g.name).toEqual(g.body)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it("never throws on non-JSON-safe props, and cause never appears", () => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- non-JSON-safe props on purpose
    const e = NotFound({ id: "z", n: 1n, f: () => 1, cause: new Error("secret") } as never)
    const p = problem(e, 404)
    expect(p).toEqual({
      type: "https://friday-friday.dev/errors/not-found",
      title: "Not Found",
      status: 404,
      tag: "NotFound",
      id: "z"
    })
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

  it("invalid body -> 422 ValidationFailure problem, application/problem+json", async () => {
    const res = await itemsApp.request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { "content-type": "application/json" }
    })
    expect(res.status).toBe(422)
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE)
    const body = await json(res)
    expect(body).toMatchObject({
      type: validationGolden?.body.type,
      title: validationGolden?.body.title,
      status: 422,
      tag: "ValidationFailure",
      issues: [{ path: ["name"], message: expect.any(String) }]
    })
  })

  it("uses schema's projection: root issue path [] and no vendor extras (#37 repro)", async () => {
    const res = await passwordApp.request("/signup", {
      method: "POST",
      body: JSON.stringify({ password: "hunter2" }),
      headers: { "content-type": "application/json" }
    })
    expect(res.status).toBe(422)
    const body = await json(res)
    expect(body).toEqual({
      type: "https://friday-friday.dev/errors/validation-failure",
      title: "Validation Failure",
      status: 422,
      tag: "ValidationFailure",
      issues: [{ message: "Passwords differ", path: [] }, { message: "Too short", path: ["password"] }]
    })
    expect(JSON.stringify(body)).not.toContain("hunter2")
  })

  it("a throwing vendor validate is a defect: 500 InternalDefect, original reported", async () => {
    throwingReports.length = 0
    const res = await throwingApp.request("/x", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    })
    expect(res.status).toBe(500)
    const body = await json(res)
    expect(body).toEqual(defectGolden?.body)
    expect(JSON.stringify(body)).not.toContain("hunter2")
    expect(throwingReports).toHaveLength(1)
  })
})

describe("onErrorHandler", () => {
  it("HTTPException passes through with its own status AND custom headers (report's U claim)", async () => {
    const res = await errorApp.request("/http-ex")
    expect(res.status).toBe(401)
    expect(res.headers.get("x-custom")).toBe("kept") // headers preserved
    expect(await res.text()).toBe("Custom unauthorized body")
  })

  it("unknown throw -> core InternalDefect envelope with the fixed message; the original reaches report", async () => {
    reports.length = 0
    const res = await errorApp.request("/boom")
    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE)
    const body = await json(res)
    expect(body).toEqual(defectGolden?.body)
    expect(JSON.stringify(body)).not.toContain("hunter2")
    expect(reports).toEqual([boom])
    expect(fromWire(body)).toEqual({ _tag: "InternalDefect", message: "Internal server error" })
  })

  it("a thrown Panic gets the same envelope (no cause text on the wire)", async () => {
    const res = await errorApp.request("/panic")
    expect(res.status).toBe(500)
    const body = await json(res)
    expect(body).toEqual(defectGolden?.body)
    expect(JSON.stringify(body)).not.toContain("hunter2")
  })

  it("works without a reporter", async () => {
    const res = await defaultErrorApp.request("/boom")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual(defectGolden?.body)
  })
})
