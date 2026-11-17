/**
 * `@friday-friday/http` runtime tests — real wire truth: a Node http server serves
 * problem+json, plain JSON, invalid JSON and slow responses; a closed port proves
 * NetworkError. The reconstruction round-trip proves losslessness against the same
 * problem shape `@friday-friday/next`'s toResponse emits.
 */
import { ok, taggedError } from "@friday-friday/core"
import { Timeout as timeoutFactory } from "@friday-friday/core/async"
import { fetchResult, reconstruct } from "@friday-friday/http"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()

let server: Server
let base = ""
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/user/1") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "1", name: "ada" }))
      return
    }
    if (req.url === "/user/missing") {
      // The exact shape @friday-friday/next toResponse emits for a tagged error.
      res.writeHead(404, { "content-type": "application/problem+json" })
      res.end(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404, tag: "NotFound", id: "missing" }))
      return
    }
    if (req.url === "/foreign-problem") {
      res.writeHead(503, { "content-type": "application/problem+json" })
      res.end(JSON.stringify({ type: "about:blank", title: "Unavailable", status: 503 }))
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

  it("problem+json 404 -> Err(HttpError) with the parsed problem; reconstruct() round-trips the tagged error", async () => {
    const r = await fetchResult(`${base}/user/missing`)
    if (r.ok) throw new Error("expected Err")
    expect(r.error._tag).toBe("HttpError")
    if (r.error._tag !== "HttpError") throw new Error("expected HttpError")
    expect(r.error.status).toBe(404)
    const serverError = NotFound({ id: "missing" })
    expect(reconstruct(r.error.problem)).toEqual(serverError)
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

  it("invalid 2xx JSON -> Err(NetworkError)", async () => {
    const r = await fetchResult(`${base}/bad-json`)
    if (r.ok) throw new Error("expected Err")
    expect(r.error._tag).toBe("NetworkError")
  })

  it("timeoutMs budget -> Err(Timeout{ms})", async () => {
    const r = await fetchResult(`${base}/slow`, { timeoutMs: 60 })
    if (r.ok) throw new Error("expected Err")
    expect(r.error).toEqual(timeoutFactory({ ms: 60 }))
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
