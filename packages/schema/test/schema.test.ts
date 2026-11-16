/**
 * `@friday-friday/schema` tests. Zod is a DEV-ONLY fixture here: the runtime surface imports
 * `@standard-schema/spec` types exclusively, proving no vendor hard-dependency.
 */
import { err, ok, Panic, taggedError } from "@friday-friday/core"
import {
  type Brand,
  brand,
  branded,
  parse,
  parseAsync,
  toFieldErrors,
  toFormErrors,
  toJsonSchema,
  ValidationFailure
} from "@friday-friday/schema"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, it } from "vitest"
import { z } from "zod"

describe("parse", () => {
  const User = z.object({ id: z.string(), age: z.number() })

  it("returns ok with the inferred output", () => {
    const r = parse(User, { id: "u1", age: 30 })
    expect(r).toEqual(ok({ id: "u1", age: 30 }))
    if (r.ok) expect(r.value.id).toBe("u1")
  })

  it("returns ValidationFailure with normalized issue paths", () => {
    const r = parse(User, { id: 1, age: "not-a-number" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error._tag).toBe("ValidationFailure")
      expect(r.error.issues).toEqual([
        { message: expect.any(String), path: ["id"] },
        { message: expect.any(String), path: ["age"] }
      ])
    }
  })

  it("throws Panic on async-validating schemas (use parseAsync)", () => {
    const AsyncSchema: z.ZodType<string> = z.string().refine(async (v) => v.length > 0)
    expect(() => parse(AsyncSchema, "x")).toThrow(Panic)
  })

  it("symbol path segments are noted as [symbol] placeholders", () => {
    // Build an issue path with a symbol via a hand-rolled Standard Schema implementation.
    const sym = Symbol("secret")
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (_input: unknown) => ({
          issues: [{ message: "bad", path: [sym, "field"] }]
        })
      }
    }
    const r = parse(schema, null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.issues[0]?.path).toEqual(["[symbol]", "field"])
  })
})

describe("parseAsync", () => {
  it("awaits async-validating schemas", async () => {
    const AsyncSchema = z.string().refine(async (v) => v.length > 0, "empty")
    expect(await parseAsync(AsyncSchema, "ok")).toEqual(ok("ok"))
    expect(await parseAsync(AsyncSchema, "")).toEqual(
      err(ValidationFailure({ issues: [{ message: "empty", path: [] }] }))
    )
  })

  it("works for sync schemas too", async () => {
    expect(await parseAsync(z.number(), 5)).toEqual(ok(5))
  })
})

describe("flatteners", () => {
  const Profile = z.object({ name: z.string(), address: z.object({ city: z.string() }) })

  it("toFieldErrors keys by dot-joined path; root issues under _errors", () => {
    const r = parse(Profile, { name: 1, address: { city: 2 }, extra: true })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const fields = toFieldErrors(r.error)
      expect(fields["name"]).toBeDefined()
      expect(fields["address.city"]).toBeDefined()
    }
  })

  it("toFormErrors collects root issues under _errors", () => {
    const Failing = z.object({ a: z.string() }).refine(() => false, "root-level problem")
    const r = parse(Failing, { a: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const form = toFormErrors(r.error)
      expect(form["_errors"]).toContain("root-level problem")
    }
  })
})

describe("branded", () => {
  const UserId = z.string()
  it("validates then stamps the phantom brand (zero runtime footprint)", () => {
    const parseUserId = branded(UserId, "UserId")
    const r = parseUserId("u-123")
    expect(r).toEqual(ok("u-123"))
    if (r.ok) {
      const brandedValue: Brand<string, "UserId"> = r.value
      expect(brandedValue).toBe("u-123")
      // The brand key is type-level only: the unique symbol is absent at runtime.
      expect(Reflect.has(brandedValue, brand)).toBe(false)
    }
  })

  it("propagates ValidationFailure", () => {
    const parseUserId = branded(UserId, "UserId")
    const r = parseUserId(123)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("ValidationFailure")
  })
})

describe("toJsonSchema", () => {
  it("wraps a working converter in ok", () => {
    const impl: StandardJSONSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        jsonSchema: {
          input: (_opts: { target?: string }) => ({ type: "string" }),
          output: (_opts: { target?: string }) => ({ type: "string" })
        }
      }
    }
    expect(toJsonSchema(impl, "input")).toEqual(ok({ type: "string" }))
    expect(toJsonSchema(impl, "output", "draft-07")).toEqual(ok({ type: "string" }))
  })

  it("wraps a throwing converter in Err(Unsupported)", () => {
    const impl: StandardJSONSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        jsonSchema: {
          input: (_opts: { target?: string }) => {
            throw new Error("no json schema for this vendor")
          },
          output: () => ({})
        }
      }
    }
    const r = toJsonSchema(impl, "input")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error._tag).toBe("Unsupported")
      expect(r.error.reason).toContain("no json schema")
    }
  })
})

describe("no vendor hard-dependency", () => {
  it("works with any hand-rolled Standard Schema V1 implementation", () => {
    const Vendor: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (
          input: unknown
        ) => (typeof input === "string" ? { value: input } : { issues: [{ message: "must be a string" }] })
      }
    }
    expect(parse(Vendor, "hi")).toEqual(ok("hi"))
    expect(parse(Vendor, 42)).toEqual(err(ValidationFailure({ issues: [{ message: "must be a string", path: [] }] })))
  })

  it("tagged errors stay structural across module copies", () => {
    const LocalFailure = taggedError("ValidationFailure")<{ issues: [] }>()
    const e = LocalFailure({ issues: [] })
    expect(e._tag).toBe("ValidationFailure")
    expect(JSON.parse(JSON.stringify(e))._tag).toBe("ValidationFailure")
  })
})
