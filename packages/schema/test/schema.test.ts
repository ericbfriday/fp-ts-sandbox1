/**
 * `@friday-friday/schema` tests. Zod is a DEV-ONLY fixture here: the runtime surface imports
 * `@standard-schema/spec` types exclusively, proving no vendor hard-dependency.
 */
import { err, ok, Panic, taggedError } from "@friday-friday/core"
import {
  type Brand,
  type brand,
  branded,
  parse,
  parseAsync,
  toFieldErrors,
  toFormErrors,
  toJsonSchema,
  toValidationFailure,
  ValidationFailure
} from "@friday-friday/schema"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { type } from "arktype"
import * as v from "valibot"
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

  it("a validate that throws is a defect: Panic with the original cause", () => {
    const boom = new Error("vendor exploded")
    const throwing: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: () => {
          throw boom
        }
      }
    }
    expect(() => parse(throwing, null)).toThrow(Panic)
    try {
      parse(throwing, null)
    } catch (e) {
      expect(e).toMatchObject({ cause: boom })
    }
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

describe("toValidationFailure (the one ValidationFailure producer)", () => {
  it("projects Standard Schema issues to message + property-key path only", () => {
    // Shapes vendors really emit: valibot-style extras on the issue and on each path segment.
    const segment = { key: "user", type: "object", input: { secret: "pw" }, value: {} }
    const vendorIssue = {
      message: "Invalid type",
      path: [segment, 0],
      kind: "schema",
      input: "hunter2",
      expected: "string",
      received: "number"
    }
    const issues: ReadonlyArray<StandardSchemaV1.Issue> = [vendorIssue, { message: "a must equal b" }]
    expect(toValidationFailure(issues)).toStrictEqual({
      _tag: "ValidationFailure",
      issues: [
        { message: "Invalid type", path: ["user", 0] },
        { message: "a must equal b", path: [] }
      ]
    })
  })

  it("parse emits exactly the projection (valibot root issue: path [], no input echoed)", () => {
    const Pair = v.pipe(
      v.object({ a: v.string(), b: v.string() }),
      v.check((x) => x.a === x.b, "a must equal b")
    )
    const r = parse(Pair, { a: "x", b: "y" })
    expect(r).toStrictEqual(err(toValidationFailure([{ message: "a must equal b" }])))
    expect(JSON.stringify(r)).not.toContain("\"x\"")
  })

  it("never carries vendor extras such as `input` (zod, valibot, arktype)", () => {
    // NOTE: the vendor-authored `message` text is kept verbatim; valibot's default message
    // embeds the received value (`… but received "<value>"`), which the projection cannot strip.
    const secret = "sk_live_do_not_echo"
    for (const S of [z.object({ pw: z.number() }), v.object({ pw: v.number() }), type({ pw: "number" })]) {
      const r = parse(S, { pw: secret })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        for (const issue of r.error.issues) {
          expect(Object.keys(issue).sort()).toEqual(["message", "path"])
          expect(JSON.stringify(issue.path)).not.toContain(secret)
        }
      }
    }
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

  // IDEA §4.3: a vendor `validate` that throws is a defect — it rejects as Panic, never a sync throw.
  const boom = new Error("vendor exploded")
  const throwing: StandardSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate: () => {
        throw boom
      }
    }
  }
  const rejecting: StandardSchemaV1 = {
    "~standard": { version: 1, vendor: "fixture", validate: () => Promise.reject(boom) }
  }

  it("never throws synchronously when validate throws: it rejects with Panic(cause)", async () => {
    let pending: Promise<unknown> | undefined
    expect(() => {
      pending = parseAsync(throwing, null)
    }).not.toThrow()
    await expect(pending).rejects.toBeInstanceOf(Panic)
    await expect(pending).rejects.toMatchObject({ cause: boom })
  })

  it("an async validate that rejects also rejects with Panic(cause)", async () => {
    await expect(parseAsync(rejecting, null)).rejects.toBeInstanceOf(Panic)
    await expect(parseAsync(rejecting, null)).rejects.toMatchObject({ cause: boom })
  })

  it("an existing Panic passes through unwrapped", async () => {
    const panic = new Panic("already a defect")
    const panicking: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: () => {
          throw panic
        }
      }
    }
    await expect(parseAsync(panicking, null)).rejects.toBe(panic)
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

  it("readers tolerate failures rebuilt from the wire: a missing path is the root", () => {
    // Exactly what hono `sv` put on the wire before #32, after a JSON round-trip (repro in #32).
    const rebuilt = {
      _tag: "ValidationFailure",
      issues: [{ message: "a must equal b" }, { message: "too short", path: ["name"] }]
    } as const
    expect(toFieldErrors(rebuilt)).toEqual({ _errors: ["a must equal b"], name: ["too short"] })
    expect(toFormErrors(rebuilt)).toEqual({ _errors: ["a must equal b"], name: ["too short"] })
    // JSON has no `undefined`: some encoders write the missing root path as `null`.
    expect(toFieldErrors({ issues: [{ message: "root", path: null }] })).toEqual({ _errors: ["root"] })
  })

  it("toFormErrors is toFieldErrors with an always-present _errors bucket", () => {
    const cases = [
      toValidationFailure([]),
      toValidationFailure([{ message: "x", path: ["a", 0] }, { message: "y", path: ["a", 0] }]),
      toValidationFailure([{ message: "root" }, { message: "b", path: ["b"] }])
    ]
    expect(cases.map(toFormErrors)).toEqual([
      { _errors: [] },
      { _errors: [], "a.0": ["x", "y"] },
      { _errors: ["root"], b: ["b"] }
    ])
    expect(cases.map(toFieldErrors)).toEqual([{}, { "a.0": ["x", "y"] }, { _errors: ["root"], b: ["b"] }])
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
    }
  })

  it("the brand is type-only: no runtime key is added to branded objects", () => {
    const parseUser = branded(z.object({ id: z.string() }), "User")
    const r = parseUser({ id: "u-1" })
    expect(r).toStrictEqual(ok({ id: "u-1" }))
    if (r.ok) {
      expect(Reflect.ownKeys(r.value)).toEqual(["id"])
      // `brand` is importable only in type positions (a value import would be a runtime SyntaxError).
      const keyed: { readonly [brand]: "User" } = r.value
      expect(keyed).toBe(r.value)
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

describe("vendor fixtures (dev-only; proving no runtime hard dep)", () => {
  it("valibot schema parses", () => {
    const VSchema = v.object({ id: v.string() })
    expect(parse(VSchema, { id: "v1" })).toEqual(ok({ id: "v1" }))
  })

  it("arktype schema parses", () => {
    const ASchema = type({ id: "string" })
    expect(parse(ASchema, { id: "a1" })).toEqual(ok({ id: "a1" }))
  })

  it("valibot failures normalize to ValidationFailure", () => {
    const VSchema = v.object({ id: v.string() })
    const r = parse(VSchema, { id: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error._tag).toBe("ValidationFailure")
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
