/**
 * `@friday-friday/trpc` runtime tests — real tRPC v11 router served through the standalone
 * fetch adapter and called with a real `@trpc/client` httpBatchLink (fetch wired straight
 * into the handler, so the whole wire encoding is exercised without a socket).
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client"
import { initTRPC } from "@trpc/server"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

/* oxlint-disable no-unsafe-type-assertion, no-unnecessary-type-assertion -- wire probes: tRPC error shapes are structurally accessed in tests */
import { err, ok, taggedError } from "@friday-friday/core"
import { errorFormatter, fromTRPC, resultMiddleware, resultProcedure, sanitize } from "@friday-friday/trpc"

const NotFound = taggedError("NotFound")<{ id: string }>()
const Conflict = taggedError("Conflict")<{ field: string }>()

const t = initTRPC.create({ errorFormatter })
const domain = t.procedure.use(resultMiddleware({ NotFound: "NOT_FOUND", Conflict: "CONFLICT" }))

const router = t.router({
  getUser: domain.input(z.object({ id: z.string() })).query(({ input }) => {
    if (input.id === "missing") return err(NotFound({ id: input.id }))
    return ok({ id: input.id, name: "ada" })
  }),
  rename: domain.input(z.object({ id: z.string() })).mutation(() => {
    return err(Conflict({ field: "name" }))
  }),
  formFlow: resultProcedure({ channel: "data" })(
    t.procedure.input(z.object({ name: z.string() })).mutation(({ input }) => {
      return input.name.length < 2 ? err(Conflict({ field: "name" })) : ok({ renamed: input.name })
    })
  ),
  // Validator failure: zod's ~standard issues must surface as data.fl = ValidationError.
  strict: t.procedure.input(z.object({ n: z.number() })).query(() => "ok")
})

type Router = typeof router

let client: ReturnType<typeof createTRPCClient<Router>>
beforeAll(() => {
  client = createTRPCClient<Router>({
    links: [
      httpBatchLink({
        url: "http://localhost/trpc",
        fetch: async (input, init) => {
          // Route the client's request straight into the standalone handler (wire truth
          // without a socket).
          const req = new Request(
            input as string,
            // oxlint-disable-next-line no-unsafe-type-assertion -- tRPC's RequestInitEsque is structurally RequestInit for our usage
            init as RequestInit | undefined
          )
          return fetchRequestHandler({
            endpoint: "/trpc",
            router,
            // oxlint-disable-next-line no-unsafe-type-assertion -- adapter's createContext signature is (opts) => ctx
            createContext: () => ({}),
            req
          }) as Promise<Response>
        }
      })
    ]
  })
})

describe("error channel (resultMiddleware + errorFormatter)", () => {
  it("Ok -> plain value over the wire", async () => {
    const r = await fromTRPC<{ id: string; name: string }, ReturnType<typeof NotFound> | ReturnType<typeof Conflict>>(
      client.getUser.query({ id: "1" })
    )
    expect(r).toEqual(ok({ id: "1", name: "ada" }))
  })

  it("Err -> TRPCError with mapped code; data.fl carries the sanitized tagged error; fromTRPC reconstructs it", async () => {
    let caught: unknown
    try {
      await client.getUser.query({ id: "missing" })
      throw new Error("expected rejection")
    } catch (e) {
      caught = e
    }
    // tRPC's error shape carries code + our fl member.
    const data = (caught as { data?: { code?: string; fl?: Record<string, unknown> } }).data
    expect(data?.code).toBe("NOT_FOUND")
    const fl = data?.fl
    expect(fl).toEqual({ _tag: "NotFound", id: "missing" })

    const r = await fromTRPC<{ id: string; name: string }, ReturnType<typeof NotFound> | ReturnType<typeof Conflict>>(
      client.getUser.query({ id: "missing" })
    )
    expect(r.ok).toBe(false)
    if (!r.ok && r.error._tag === "NotFound") expect(r.error.id).toBe("missing")
    else if (!r.ok) throw new Error(`expected NotFound, got ${r.error._tag}`)
  })

  it("mutation errors take the same channel", async () => {
    let caught: unknown
    try {
      await client.rename.mutate({ id: "1" })
      throw new Error("expected rejection")
    } catch (e) {
      caught = e
    }
    const data = (caught as { data?: { code?: string; fl?: Record<string, unknown> } }).data
    expect(data?.code).toBe("CONFLICT")
    expect(data?.fl).toEqual({ _tag: "Conflict", field: "name" })

    const r = await fromTRPC<never, ReturnType<typeof Conflict>>(client.rename.mutate({ id: "1" }))
    expect(r.ok).toBe(false)
    if (!r.ok && r.error._tag === "Conflict") expect(r.error.field).toBe("name")
    else if (!r.ok) throw new Error(`expected Conflict, got ${r.error._tag}`)
  })
})

describe("data channel (resultProcedure)", () => {
  it("the Result itself is the output (Err survives as data)", async () => {
    const asData = await client.formFlow.mutate({ name: "x" })
    expect(asData.ok).toBe(false)
    if (!asData.ok) expect(asData.error._tag).toBe("Conflict")

    const good = await client.formFlow.mutate({ name: "widget" })
    expect(good).toEqual(ok({ renamed: "widget" }))
  })
})

describe("validator failures format from ~standard issues (NOT instanceof ZodError)", () => {
  it("data.fl is a ValidationError with issues", async () => {
    let caught: unknown
    try {
      await client.strict.query({ n: "not-a-number" } as never)
      throw new Error("expected rejection")
    } catch (e) {
      caught = e
    }
    const fl = (caught as { data?: { fl?: unknown } }).data?.fl
    expect(fl).not.toBeNull()
    expect((fl as { tag?: string }).tag).toBe("ValidationError")
    expect(Array.isArray((fl as { issues?: unknown }).issues)).toBe(true)
  })
})

describe("sanitize", () => {
  it("strips message + cause, keeps _tag + props", () => {
    const e = NotFound({ id: "q" })
    const s = sanitize(e)
    expect(s).toEqual({ _tag: "NotFound", id: "q" })
    expect("cause" in s).toBe(false)
  })
})

describe("fromTRPC fallback", () => {
  it("non-tRPC failures -> Err(TRPCTransportError)", async () => {
    const r = await fromTRPC<string>(Promise.reject(new Error("socket hangup")))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("TRPCTransportError")
  })
})
