/**
 * `@friday-friday/trpc` runtime tests — real tRPC v11 routers served through the standalone
 * fetch adapter and called with a real `@trpc/client` httpBatchLink (fetch wired straight
 * into the handler, so the whole wire encoding is exercised without a socket). Every wire
 * assertion reads the raw response text the handler produced, not a client-side object.
 */
import { createTRPCClient, httpBatchLink, type TRPCLink } from "@trpc/client"
import { type AnyTRPCRouter, initTRPC, TRPCError } from "@trpc/server"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { z } from "zod"

/* oxlint-disable no-unsafe-type-assertion, no-unnecessary-type-assertion -- wire probes: tRPC error shapes are structurally accessed in tests */
import { Conflict, err, NotFound, ok, Panic, taggedError } from "@friday-friday/core"
import type { ValidationFailure } from "@friday-friday/schema"
import { errorFormatter, fromTRPC, resultMiddleware, sanitize } from "@friday-friday/trpc"

const DbUnavailable = taggedError("DbUnavailable")<{ host?: string }>()

/** The secret every defect test throws; it must never appear in a production wire body. */
const SECRET = "connect ECONNREFUSED postgres://admin:hunter2@db"
const DEFECT_TEXT = "Internal server error"

const buildRouter = (opts: { isDev: boolean; report?: (cause: unknown) => void }) => {
  const t = initTRPC.create({
    isDev: opts.isDev,
    errorFormatter: errorFormatter(opts.report === undefined ? {} : { report: opts.report })
  })
  const domain = t.procedure.use(
    resultMiddleware({ NotFound: "NOT_FOUND", Conflict: "CONFLICT" })
  )
  return t.router({
    getUser: domain.input(z.object({ id: z.string() })).query(({ input }) => {
      if (input.id === "missing") return err(NotFound({ id: input.id, message: "no such user" }))
      if (input.id === "db") return err(DbUnavailable({ host: "db.internal:5432", message: SECRET }))
      return ok({ id: input.id, name: "ada" })
    }),
    rename: domain.input(z.object({ id: z.string() })).mutation(() => {
      return err(Conflict({ field: "name" }))
    }),
    // Data channel: a plain procedure (no resultMiddleware) returns the Result as its output.
    formFlow: t.procedure.input(z.object({ name: z.string() })).mutation(({ input }) => {
      return input.name.length < 2 ? err(Conflict({ field: "name" })) : ok({ renamed: input.name })
    }),
    // Validator failures (zod + valibot): the schema projection, never the vendor issue objects.
    strict: t.procedure.input(z.object({ n: z.number() })).query(() => "ok"),
    signup: t.procedure
      .input(v.object({ email: v.pipe(v.string(), v.email()), password: v.string() }))
      .mutation(() => "welcome"),
    // Defects: a raw throw, and a throw already triaged to Panic (Panic copies cause.message).
    crash: t.procedure.query(() => {
      throw new Error(SECRET)
    }),
    panic: t.procedure.query(() => {
      throw new Panic(new Error(SECRET))
    }),
    // A deliberate, non-defect TRPCError keeps its own message.
    forbidden: t.procedure.query(() => {
      throw new TRPCError({ code: "FORBIDDEN", message: "members only" })
    })
  })
}

type AppRouter = ReturnType<typeof buildRouter>

/** A client wired straight into the fetch handler; `wire()` is the last raw response text. */
const connect = (router: AnyTRPCRouter) => {
  let last = ""
  const link: TRPCLink<AppRouter> = httpBatchLink({
    url: "http://localhost/trpc",
    fetch: async (input, init) => {
      const req = new Request(
        input as string,
        // oxlint-disable-next-line no-unsafe-type-assertion -- tRPC's RequestInitEsque is structurally RequestInit for our usage
        init as RequestInit | undefined
      )
      const res = await fetchRequestHandler({ endpoint: "/trpc", router, createContext: () => ({}), req })
      last = await res.clone().text()
      return res
    }
  })
  return { client: createTRPCClient<AppRouter>({ links: [link] }), wire: (): string => last }
}

/** Await a rejection and return the thrown value. */
const rejection = async (p: PromiseLike<unknown>): Promise<unknown> => {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error("expected rejection")
}

const dataOf = (e: unknown) => (e as { data?: { code?: string; friday_friday?: unknown; stack?: unknown } }).data

const prod = connect(buildRouter({ isDev: false }))
const { client } = prod

describe("error channel (resultMiddleware + errorFormatter)", () => {
  it("Ok -> plain value over the wire", async () => {
    const r = await fromTRPC<{ id: string; name: string }, ReturnType<typeof NotFound> | ReturnType<typeof Conflict>>(
      client.getUser.query({ id: "1" })
    )
    expect(r).toEqual(ok({ id: "1", name: "ada" }))
  })

  it("Err -> TRPCError with mapped code; data.friday_friday is core's sanitized error, message included", async () => {
    const data = dataOf(await rejection(client.getUser.query({ id: "missing" })))
    expect(data?.code).toBe("NOT_FOUND")
    expect(data?.friday_friday).toEqual({ _tag: "NotFound", message: "no such user", id: "missing" })
  })

  it("fromTRPC reconstructs via the wire module: message survives", async () => {
    const r = await fromTRPC<{ id: string; name: string }, ReturnType<typeof NotFound> | ReturnType<typeof Conflict>>(
      client.getUser.query({ id: "missing" })
    )
    expect(r).toEqual(err({ _tag: "NotFound", message: "no such user", id: "missing" }))
  })

  it("mutation errors take the same channel", async () => {
    const data = dataOf(await rejection(client.rename.mutate({ id: "1" })))
    expect(data?.code).toBe("CONFLICT")
    expect(data?.friday_friday).toEqual({ _tag: "Conflict", field: "name" })

    const r = await fromTRPC<never, ReturnType<typeof Conflict>>(client.rename.mutate({ id: "1" }))
    expect(r).toEqual(err({ _tag: "Conflict", field: "name" }))
  })

  it("the formatter writes no member under the report's `fl` placeholder name", async () => {
    const data = dataOf(await rejection(client.getUser.query({ id: "missing" })))
    expect(data !== undefined && "fl" in data).toBe(false)
  })
})

describe("data channel (a plain procedure, no resultMiddleware)", () => {
  it("the Result itself is the output (Err survives as data)", async () => {
    const asData = await client.formFlow.mutate({ name: "x" })
    expect(asData.ok).toBe(false)
    if (!asData.ok) expect(asData.error._tag).toBe("Conflict")

    const good = await client.formFlow.mutate({ name: "widget" })
    expect(good).toEqual(ok({ renamed: "widget" }))
  })
})

describe("validator failures: schema's projection (message + path only), NOT the vendor issues", () => {
  it("valibot: a bad signup never echoes the submitted input (the password) back", async () => {
    const data = dataOf(await rejection(client.signup.mutate({ email: "nope", password: "hunter2" })))
    expect(data?.code).toBe("BAD_REQUEST")
    expect(data?.friday_friday).toEqual({
      _tag: "ValidationFailure",
      issues: [{ message: "Invalid email: Received \"nope\"", path: ["email"] }]
    })
    expect(prod.wire()).not.toContain("hunter2")
    expect(prod.wire()).not.toContain("\"input\"")
  })

  it("zod: same projection; fromTRPC rebuilds schema's ValidationFailure", async () => {
    const data = dataOf(await rejection(client.strict.query({ n: "not-a-number" } as never)))
    const fl = data?.friday_friday as { _tag?: string; issues?: ReadonlyArray<object> }
    expect(fl._tag).toBe("ValidationFailure")
    expect(fl.issues?.map((i) => Object.keys(i).toSorted())).toEqual([["message", "path"]])
    expect(prod.wire()).not.toContain("\"input\"")

    const r = await fromTRPC<string, ValidationFailure>(client.strict.query({ n: "x" } as never))
    expect(r.ok).toBe(false)
    if (!r.ok && r.error._tag === "ValidationFailure") expect(r.error.issues[0]?.path).toEqual(["n"])
    else throw new Error("expected ValidationFailure")
  })
})

describe("defects (INTERNAL_SERVER_ERROR): fixed text in production, original to the reporter", () => {
  it.each(["crash", "panic"] as const)("%s: production wire carries no defect text", async (proc) => {
    const reported: Array<unknown> = []
    const app = connect(buildRouter({ isDev: false, report: (c) => reported.push(c) }))
    const e = await rejection(app.client[proc].query())
    expect((e as Error).message).toBe(DEFECT_TEXT)
    expect(dataOf(e)?.code).toBe("INTERNAL_SERVER_ERROR")
    expect(dataOf(e)?.friday_friday).toEqual({ _tag: "InternalDefect", message: DEFECT_TEXT })
    expect(app.wire()).not.toContain("hunter2")
    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toContain("hunter2")
  })

  it("an Err whose tag has no mapped code is a defect too: no props, no text on the wire", async () => {
    const reported: Array<unknown> = []
    const app = connect(buildRouter({ isDev: false, report: (c) => reported.push(c) }))
    const e = await rejection(app.client.getUser.query({ id: "db" }))
    expect((e as Error).message).toBe(DEFECT_TEXT)
    expect(dataOf(e)?.friday_friday).toEqual({ _tag: "InternalDefect", message: DEFECT_TEXT })
    expect(app.wire()).not.toContain("hunter2")
    expect(app.wire()).not.toContain("db.internal")
    expect(reported).toHaveLength(1)

    const r = await fromTRPC<never, ReturnType<typeof NotFound>>(app.client.getUser.query({ id: "db" }))
    expect(r).toEqual(err({ _tag: "TRPCTransportError", code: "INTERNAL_SERVER_ERROR", message: DEFECT_TEXT }))
  })

  it("development keeps tRPC's own message (isDev), still the envelope under data.friday_friday", async () => {
    const dev = connect(buildRouter({ isDev: true }))
    const e = await rejection(dev.client.crash.query())
    expect((e as Error).message).toBe(SECRET)
    expect(dataOf(e)?.friday_friday).toEqual({ _tag: "InternalDefect", message: DEFECT_TEXT })
  })

  it("a deliberate TRPCError (not a defect) keeps its message and carries no envelope", async () => {
    const e = await rejection(client.forbidden.query())
    expect((e as Error).message).toBe("members only")
    expect(dataOf(e)?.friday_friday).toBeNull()
  })

  it("a throwing reporter never breaks the response", async () => {
    const app = connect(buildRouter({
      isDev: false,
      report: () => {
        throw new Error("reporter down")
      }
    }))
    const e = await rejection(app.client.crash.query())
    expect((e as Error).message).toBe(DEFECT_TEXT)
  })
})

describe("sanitize (core wire projection)", () => {
  it("keeps _tag, message and JSON-safe props; drops cause", () => {
    const s = sanitize(NotFound({ id: "q", message: "gone", cause: new Error(SECRET) }))
    expect(s).toEqual({ _tag: "NotFound", message: "gone", id: "q" })
  })

  it("never throws on a bigint or function prop; drops them", () => {
    const odd = { _tag: "Conflict", field: "name", version: 10n, fn: () => 1 }
    expect(sanitize(odd)).toEqual({ _tag: "Conflict", field: "name" })
  })
})

describe("resultMiddleware", () => {
  it("an inherited key such as `constructor` is not a mapped code (unmapped -> defect)", async () => {
    const t = initTRPC.create({ isDev: false, errorFormatter: errorFormatter() })
    const Weird = taggedError("constructor")()
    const router = t.router({ q: t.procedure.use(resultMiddleware({})).query(() => err(Weird({}))) })
    const app = connect(router)
    const e = await rejection((app.client as unknown as { q: { query: () => Promise<unknown> } }).q.query())
    expect(dataOf(e)?.code).toBe("INTERNAL_SERVER_ERROR")
  })
})

describe("fromTRPC fallback", () => {
  it("non-tRPC failures -> Err(TRPCTransportError)", async () => {
    const r = await fromTRPC<string>(Promise.reject(new Error("socket hangup")))
    expect(r).toEqual(err({ _tag: "TRPCTransportError", message: "socket hangup" }))
  })
})
