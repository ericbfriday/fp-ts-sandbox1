/**
 * `@friday-friday/env` runtime tests.
 */
import { envRecord, parseEnv } from "@friday-friday/env"
import { type } from "arktype"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url()
})

describe("parseEnv", () => {
  it("valid env -> ok with coerced values", () => {
    const r = parseEnv(EnvSchema, { DATABASE_URL: "postgres://localhost/app", PORT: "5433" })
    expect(r).toEqual({
      ok: true,
      value: { NODE_ENV: "development", PORT: 5433, DATABASE_URL: "postgres://localhost/app" }
    })
  })

  it("invalid env -> Err(ValidationFailure) with field errors (no throw at import time)", () => {
    const r = parseEnv(EnvSchema, { DATABASE_URL: "not-a-url" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error._tag).toBe("ValidationFailure")
      expect(Array.isArray(r.error.issues)).toBe(true)
    }
  })

  it("missing required var -> field error naming it", () => {
    const r = parseEnv(EnvSchema, {})
    if (!r.ok) {
      const paths = r.error.issues.map((i) => JSON.stringify(i.path))
      expect(paths.some((p) => p.includes("DATABASE_URL"))).toBe(true)
    } else {
      throw new Error("expected Err")
    }
  })
})

// Report section 5.9 + spec #30 story 26: vendors that echo input must not leak env values.
describe("parseEnv redaction", () => {
  const SECRET = "sk_live_SUPERSECRET"

  it.each([
    ["valibot picklist", v.object({ MODE: v.picklist(["a", "b"]) })],
    ["arktype literal union", type({ MODE: "'a' | 'b'" })]
  ])("%s: issue messages never contain the raw value", (_name, schema) => {
    const r = parseEnv(schema, { MODE: SECRET })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toHaveLength(1)
    expect([...(r.error.issues[0]?.path ?? [])]).toEqual(["MODE"])
    expect(JSON.stringify(r.error)).not.toContain(SECRET)
    expect(r.error.issues[0]?.message).toContain("[redacted]")
  })

  it("redacts a short value only where it stands alone, keeping the rest of the message", () => {
    const Port = v.object({ PORT: v.pipe(v.string(), v.transform(Number), v.minValue(1024)) })
    const r = parseEnv(Port, { PORT: "1" })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues[0]?.message).toBe("Invalid value: Expected >=1024 but received [redacted]")
  })

  // Valibot echoes the raw string inside quotes; ArkType echoes it JSON-escaped.
  it.each([
    ["valibot", v.object({ MODE: v.picklist(["a", "b"]) })],
    ["arktype", type({ MODE: "'a' | 'b'" })]
  ])("%s: redacts the echo of a value with quotes or backslashes", (_name, schema) => {
    const value = String.raw`sk"live\SECRET`
    const r = parseEnv(schema, { MODE: value })
    if (r.ok) throw new Error("expected Err")
    const message = r.error.issues[0]?.message ?? ""
    expect(message).not.toContain("SECRET")
    expect(message).toContain("[redacted]")
  })

  it("root-level issues have every variable's value redacted", () => {
    const Pair = v.pipe(
      v.object({ A: v.string(), B: v.string() }),
      v.check((o) => o.A !== o.B, (issue) => `A and B must differ, got ${JSON.stringify(issue.input)}`)
    )
    const r = parseEnv(Pair, { A: "hunter2", B: "hunter2", OTHER: "s3cret-token" })
    if (r.ok) throw new Error("expected Err")
    expect([...(r.error.issues[0]?.path ?? [])]).toEqual([])
    expect(JSON.stringify(r.error)).not.toMatch(/hunter2|s3cret-token/)
  })

  it("does not redact the values of other variables in a field issue", () => {
    const r = parseEnv(v.object({ MODE: v.picklist(["a", "b"]) }), { MODE: "c", UNRELATED: "Expected" })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues[0]?.message).toBe("Invalid type: Expected (\"a\" | \"b\") but received \"[redacted]\"")
  })
})

describe("envRecord", () => {
  it("returns overrides when given", () => {
    expect(envRecord({ A: "b" })).toEqual({ A: "b" })
  })

  it("falls back to process.env (live)", () => {
    const rec = envRecord()
    expect(typeof rec).toBe("object")
  })
})
