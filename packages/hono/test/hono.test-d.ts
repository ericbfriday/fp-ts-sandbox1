/**
 * `@friday-friday/hono` type tests — the status-literal union is the product here.
 */
import { err, ok, taggedError } from "@friday-friday/core"
import { respond, sv } from "@friday-friday/hono"
import { Hono } from "hono"
import { hc } from "hono/client"
import { describe, expectTypeOf, it } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()
const Forbidden = taggedError("Forbidden")<{ required: string }>()
const Teapot = taggedError("Teapot")<{}>()

type AppError = ReturnType<typeof NotFound> | ReturnType<typeof Forbidden> | ReturnType<typeof Teapot>

// Sub-apps per the report's TS2589 guidance (small slice types, per-slice hc clients).
// sv + itemsApp are declared FIRST: respond's status-literal return types hit
// instantiation-depth limits and degrade LATER generic inference in this file (observed).
const itemsValidator = sv<"json", z.ZodObject<{ name: z.ZodString }>>("json", z.object({ name: z.string().min(2) }))
const itemsApp = new Hono().post("/items", itemsValidator, (c) => {
  const body = c.req.valid("json")
  return c.json({ created: body.name }, 201)
})

const usersApp = new Hono().get("/users/:id", (c) => {
  const id = c.req.param("id")
  const r: { ok: true; value: { id: string; name: string } } | { ok: false; error: AppError } = id === "missing"
    ? err(NotFound({ id }))
    : ok({ id, name: "ada" })
  return respond(c, r, { NotFound: 404, Forbidden: 403, Teapot: 418 } as const)
})

describe("respond status-literal inference", () => {
  it("client infers 200 | mapped literal statuses (NOT number)", async () => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- hc(client) requires a concrete fetch impl; type tests only need the AppType
    const client = hc<typeof usersApp>("http://localhost")
    const res = await client.users[":id"].$get({ param: { id: "1" } })
    // The trap: `as number` here would collapse this to number. Literal union is the contract.
    expectTypeOf(res.status).toEqualTypeOf<200 | 403 | 404 | 418>()
    expectTypeOf(res.status).not.toEqualTypeOf<number>()
  })
})

describe("sv inference", () => {
  it("validator middleware carries the out metadata; valid() is the parsed output", () => {
    const app = new Hono().post("/items", itemsValidator, (c) => {
      const body = c.req.valid("json")
      expectTypeOf(body).toEqualTypeOf<{ name: string }>()
      return c.json({ created: body.name }, 201)
    })
    expectTypeOf(app).not.toBeNever()
  })

  it("itemsApp client input is the schema input, output the handler json", async () => {
    const client = hc<typeof itemsApp>("http://localhost")
    expectTypeOf(client.items).not.toBeNever()
    void client
    void itemsApp
  })
})
