/**
 * `@friday-friday/http` runtime tests — real wire truth: a Node http server serves
 * problem+json, plain JSON, invalid JSON, empty and slow responses; a closed port proves
 * NetworkError. Problem bodies come from the real producer (`@friday-friday/core/wire`'s
 * `toProblem`) and from core's golden bodies (#33), never from hand-copied fixtures (#30, #40).
 */
import { ok, Panic, taggedError } from "@friday-friday/core"
import { Timeout } from "@friday-friday/core/async"
import { goldenProblems } from "@friday-friday/core/test/wire-golden"
import { PROBLEM_CONTENT_TYPE, sanitize, toDefect, toProblem } from "@friday-friday/core/wire"
import { fetchResult, reconstruct } from "@friday-friday/http"
import { createServer, type Server, type ServerResponse } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()

/** Serve `body` as RFC 9457 problem+json with its own status, as every producer does. */
const sendProblem = (res: ServerResponse, body: { readonly status: number }): void => {
  res.writeHead(body.status, { "content-type": PROBLEM_CONTENT_TYPE })
  res.end(JSON.stringify(body))
}

let server: Server
let base = ""
let slowHits = 0

/** The `Panic` that `p` rejects with (fails the test if it resolves or rejects with anything else). */
const panicOf = async (p: Promise<unknown>): Promise<Panic> => {
  try {
    await p
  } catch (cause) {
    if (cause instanceof Panic) return cause
    throw new Error("expected a Panic", { cause })
  }
  throw new Error("expected a rejection")
}
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/user/1") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "1", name: "ada" }))
      return
    }
    if (req.url === "/user/missing") {
      // The real producer: core's wire module, which next and hono both delegate to (#30).
      sendProblem(res, toProblem(NotFound({ id: "missing", message: "no such user" })))
      return
    }
    const golden = /^\/golden\/(\d+)$/.exec(req.url ?? "")
    if (golden !== null) {
      sendProblem(res, goldenProblems[Number(golden[1])]!.body)
      return
    }
    if (req.url === "/foreign-problem") {
      res.writeHead(503, { "content-type": "application/problem+json" })
      res.end(JSON.stringify({ type: "about:blank", title: "Unavailable", status: 503 }))
      return
    }
    if (req.url === "/no-content") {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === "/reset-content") {
      res.writeHead(205)
      res.end()
      return
    }
    if (req.url === "/empty") {
      res.writeHead(200, { "content-type": "application/json", "content-length": "0" })
      res.end()
      return
    }
    if (req.url === "/no-json") {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end("boom")
      return
    }
    if (req.url === "/bad-json") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{not json")
      return
    }
    if (req.url === "/slow-counted") {
      slowHits++
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      }, 400)
      return
    }
    if (req.url === "/slow-body") {
      // Headers now, body later: aborts and timeouts can land while the body is being read.
      res.writeHead(200, { "content-type": "application/json" })
      res.write("{\"id\":")
      setTimeout(() => res.end("\"1\"}"), 400)
      return
    }
    if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      }, 400)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("reconstruct — core wire golden bodies over a real server (#33, #40)", () => {
  it.each(goldenProblems.map((g, i) => [g.name, i] as const))("%s", async (_name, i) => {
    const g = goldenProblems[i]!
    const r = await fetchResult(`${base}/golden/${i}`)
    if (r.ok || r.error._tag !== "HttpError") throw new Error("expected HttpError")
    expect(r.error.status).toBe(g.body.status)
    expect(r.error.problem).toEqual(g.body)
    // The client sees exactly what the server's projection let through; a masked tag is the
    // defect envelope, never the original.
    const expected = g.body.tag === g.error._tag ? sanitize(g.error, g.options) : toDefect(undefined)
    const rebuilt = reconstruct(r.error.problem)
    expect(rebuilt).toEqual(expected)
    // ...and rebuilding the problem from it is a fixed point.
    expect(toProblem(rebuilt!, g.body.status)).toEqual(g.body)
  })

  it("message and props that collided with reserved members survive (shadowed)", async () => {
    const i = goldenProblems.findIndex((g) => g.body.shadowed !== undefined && g.options === undefined)
    const r = await fetchResult(`${base}/golden/${i}`)
    if (r.ok || r.error._tag !== "HttpError") throw new Error("expected HttpError")
    expect(reconstruct(r.error.problem)).toEqual({
      _tag: "AuthApiError",
      message: "session expired",
      code: "SESSION_EXPIRED",
      status: 401,
      type: "session",
      title: "Session",
      detail: "raw detail",
      instance: "/login",
      tag: "auth",
      shadowed: true
    })
  })
})

describe("fetchResult", () => {
  it("2xx without schema -> ok(json)", async () => {
    const r = await fetchResult<{ id: string; name: string }>(`${base}/user/1`)
    expect(r).toEqual(ok({ id: "1", name: "ada" }))
  })

  it("2xx with schema decodes via Standard Schema; mismatch -> Err(ValidationFailure)", async () => {
    const schema = z.object({ id: z.string(), name: z.string() })
    const good = await fetchResult(`${base}/user/1`, { schema })
    expect(good.ok).toBe(true)
    if (!good.ok) throw new Error("expected ok")
    expect(good.value).toEqual({ id: "1", name: "ada" })

    const strict = z.object({ id: z.number() })
    const bad = await fetchResult(`${base}/user/1`, { schema: strict })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error._tag).toBe("ValidationFailure")
  })

  it("problem+json 404 -> Err(HttpError) with the parsed problem; reconstruct() round-trips the tagged error incl. message", async () => {
    const r = await fetchResult(`${base}/user/missing`)
    if (r.ok) throw new Error("expected Err")
    expect(r.error._tag).toBe("HttpError")
    if (r.error._tag !== "HttpError") throw new Error("expected HttpError")
    expect(r.error.status).toBe(404)
    // #40 repro: `detail` was deleted and never mapped back, so the message was lost.
    expect(reconstruct(r.error.problem)).toEqual({ _tag: "NotFound", id: "missing", message: "no such user" })
  })

  it("problem+json without our tag -> HttpError with problem; reconstruct -> null", async () => {
    const r = await fetchResult(`${base}/foreign-problem`)
    if (r.ok) throw new Error("expected Err")
    if (r.error._tag !== "HttpError") throw new Error("expected HttpError")
    expect(r.error.status).toBe(503)
    expect(reconstruct(r.error.problem)).toBe(null)
  })

  it("non-JSON failure body -> HttpError without problem", async () => {
    const r = await fetchResult(`${base}/no-json`)
    if (r.ok) throw new Error("expected Err")
    if (r.error._tag !== "HttpError") throw new Error("expected HttpError")
    expect(r.error.status).toBe(500)
    expect(r.error.problem).toBeUndefined()
  })

  it("204 / 205 -> Ok(undefined), with or without a schema (no content to decode)", async () => {
    expect(await fetchResult<void>(`${base}/no-content`)).toEqual(ok(undefined))
    expect(await fetchResult<void>(`${base}/reset-content`)).toEqual(ok(undefined))
    expect(await fetchResult(`${base}/no-content`, { schema: z.object({ id: z.string() }) })).toEqual(ok(undefined))
  })

  it("empty 2xx body: Ok(undefined) without a schema; with one, `undefined` is decoded like any body", async () => {
    expect(await fetchResult<void>(`${base}/empty`)).toEqual(ok(undefined))
    expect(await fetchResult(`${base}/empty`, { schema: z.undefined() })).toEqual(ok(undefined))
    const r = await fetchResult(`${base}/empty`, { schema: z.object({ id: z.string() }) })
    if (r.ok) throw new Error("expected Err")
    expect(r.error._tag).toBe("ValidationFailure")
  })

  it("invalid 2xx JSON -> Err(NetworkError)", async () => {
    const r = await fetchResult(`${base}/bad-json`)
    if (r.ok) throw new Error("expected Err")
    expect(r.error._tag).toBe("NetworkError")
  })

  it("timeoutMs budget -> Err(Timeout{ms})", async () => {
    const r = await fetchResult(`${base}/slow`, { timeoutMs: 60 })
    if (r.ok) throw new Error("expected Err")
    expect(r.error).toEqual(Timeout({ ms: 60 }))
  })

  it("timeoutMs with a live user signal -> Err(Timeout{ms}) (only the timer fired)", async () => {
    const r = await fetchResult(`${base}/slow`, { timeoutMs: 60, signal: new AbortController().signal })
    expect(r).toEqual({ ok: false, error: Timeout({ ms: 60 }) })
  })

  it("timeoutMs expiring while the body is read -> Err(Timeout{ms})", async () => {
    const r = await fetchResult(`${base}/slow-body`, { timeoutMs: 100 })
    expect(r).toEqual({ ok: false, error: Timeout({ ms: 100 }) })
  })

  it("closed port -> Err(NetworkError); retries re-attempt then surface the transport error", async () => {
    // Port 1 is reserved and reliably refused on Windows/CI.
    const r = await fetchResult("http://127.0.0.1:1/x", { retries: 1 })
    if (r.ok) throw new Error("expected Err")
    expect(r.error._tag).toBe("NetworkError")
  })

  it("retries do NOT fire for HTTP status failures", async () => {
    let hits = 0
    const probe = createServer((_req, res) => {
      hits++
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ title: "nope" }))
    })
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const addr = probe.address()
    const url = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}/x`
    const r = await fetchResult(url, { retries: 3 })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    expect(hits).toBe(1)
    if (!r.ok) expect(r.error._tag).toBe("HttpError")
  })
})

describe("fetchResult — user abort is a defect (core convention, IDEA §4.3; #40)", () => {
  it("a user abort mid-request rejects with Panic(reason) and is never retried", async () => {
    slowHits = 0
    const ac = new AbortController()
    const reason = new Error("user navigated away")
    setTimeout(() => ac.abort(reason), 30)
    const started = Date.now()
    const panic = await panicOf(fetchResult(`${base}/slow-counted`, { signal: ac.signal, retries: 3 }))
    expect(panic.cause).toBe(reason)
    expect(slowHits).toBe(1)
    expect(Date.now() - started).toBeLessThan(300) // #40 repro: retries:3 took 405 ms
  })

  it("with timeoutMs set, a user abort is still Panic, never Timeout", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    const panic = await panicOf(fetchResult(`${base}/slow`, { signal: ac.signal, timeoutMs: 1000, retries: 2 }))
    expect(panic.cause).toBe(ac.signal.reason)
  })

  it("an already-aborted signal short-circuits: Panic, no request sent", async () => {
    slowHits = 0
    const panic = await panicOf(fetchResult(`${base}/slow-counted`, { signal: AbortSignal.abort("stop") }))
    expect(panic.cause).toBe("stop")
    expect(slowHits).toBe(0)
  })

  it("a user abort during the retry backoff is Panic, not the last NetworkError", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort("stop"), 20) // the refused attempt settles at once; the 50 ms backoff is running
    const panic = await panicOf(fetchResult("http://127.0.0.1:1/x", { signal: ac.signal, retries: 5 }))
    expect(panic.cause).toBe("stop")
  })

  it("a user abort while the body is read is Panic, not a NetworkError", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort("stop"), 50)
    const panic = await panicOf(fetchResult(`${base}/slow-body`, { signal: ac.signal, timeoutMs: 1000 }))
    expect(panic.cause).toBe("stop")
  })
})
