/**
 * `@friday-friday/env` runtime tests.
 */
import { envRecord, parseEnv } from "@friday-friday/env"
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

describe("envRecord", () => {
  it("returns overrides when given", () => {
    expect(envRecord({ A: "b" })).toEqual({ A: "b" })
  })

  it("falls back to process.env (live)", () => {
    const rec = envRecord()
    expect(typeof rec).toBe("object")
  })
})
