/**
 * `@friday-friday/env` runtime tests.
 */
import { type EnvLike, envRecord, parseEnv } from "@friday-friday/env"
import { type } from "arktype"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
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

// Report section 5.9, spec #30 story 26, issue #56: vendors echo the value, or a copy derived by a
// transform in the pipe, so parseEnv never passes vendor text through. Each issue is rebuilt from
// the variable name and whether it was set.
describe("parseEnv issue messages", () => {
  const SECRET = "sk_live_SUPERSECRET"

  it.each([
    ["valibot picklist", v.object({ MODE: v.picklist(["a", "b"]) })],
    ["arktype literal union", type({ MODE: "'a' | 'b'" })],
    ["zod enum", z.object({ MODE: z.enum(["a", "b"]) })]
  ])("%s: a set but invalid variable reads \"<NAME> is invalid\"", (_name, schema) => {
    const r = parseEnv(schema, { MODE: SECRET })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toEqual([{ message: "MODE is invalid", path: ["MODE"] }])
  })

  // Issue #56: a transform in the pipe hands the vendor a derived copy of the secret.
  it.each([
    ["trim + picklist", v.object({ MODE: v.pipe(v.string(), v.trim(), v.picklist(["a", "b"])) }), {
      MODE: ` ${SECRET} `
    }],
    ["toUpperCase + picklist", v.object({ MODE: v.pipe(v.string(), v.toUpperCase(), v.picklist(["A", "B"])) }), {
      MODE: SECRET
    }],
    [
      "parseJson + nested picklist",
      v.object({ CFG: v.pipe(v.string(), v.parseJson(), v.object({ key: v.picklist(["a"]) })) }),
      { CFG: JSON.stringify({ key: SECRET }) }
    ]
  ])("%s: the failure never contains the secret in any case", (_name, schema, env) => {
    const r = parseEnv(schema, env)
    if (r.ok) throw new Error("expected Err")
    expect(JSON.stringify(r.error).toLowerCase()).not.toContain(SECRET.toLowerCase())
  })

  it("a missing variable reads \"<NAME> is missing\"", () => {
    const r = parseEnv(z.object({ DATABASE_URL: z.string() }), {})
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toEqual([{ message: "DATABASE_URL is missing", path: ["DATABASE_URL"] }])
  })

  // A record key inside a JSON-valued variable is data (e.g. a token -> tenant map), so the path
  // stops at the variable name.
  it("a nested issue is reported against its variable, not a path into the value", () => {
    const Tenants = v.object({ TENANTS: v.pipe(v.string(), v.parseJson(), v.record(v.string(), v.picklist(["a"]))) })
    const r = parseEnv(Tenants, { TENANTS: JSON.stringify({ [SECRET]: "z" }) })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toEqual([{ message: "TENANTS is invalid", path: ["TENANTS"] }])
  })

  it("a root-level issue reads \"env is invalid\", even when its own text echoes values", () => {
    const Pair = v.pipe(
      v.object({ A: v.string(), B: v.string() }),
      v.check((o) => o.A !== o.B, (issue) => `A and B must differ, got ${JSON.stringify(issue.input)}`)
    )
    const r = parseEnv(Pair, { A: "hunter2", B: "hunter2", OTHER: "s3cret-token" })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toEqual([{ message: "env is invalid", path: [] }])
  })

  // Vite's import.meta.env carries booleans (DEV/PROD/SSR) the EnvLike type cannot express (U).
  it("tolerates non-string values in the record", () => {
    const Root = v.pipe(v.object({ A: v.string() }), v.check(() => false, "expected DEV to be true"))
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a runtime record wider than EnvLike
    const env = { A: "x", DEV: true } as unknown as EnvLike
    const r = parseEnv(Root, env)
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toEqual([{ message: "env is invalid", path: [] }])
  })

  it("reports each failing variable on its own", () => {
    const r = parseEnv(v.object({ MODE: v.picklist(["a", "b"]), PORT: v.string() }), { MODE: "c", OTHER: "x" })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues).toEqual([
      { message: "MODE is invalid", path: ["MODE"] },
      { message: "PORT is missing", path: ["PORT"] }
    ])
  })
})

// Spec #30 story 28: `FOO=` in a .env file arrives as "", which vendors treat as a value.
describe("parseEnv blank values", () => {
  it("treats \"\" as unset: optional gives undefined, default applies, coerce no longer yields 0", () => {
    const Schema = z.object({
      LOG_LEVEL: z.string().optional(),
      PORT: z.coerce.number().default(3000),
      PREFIX: z.string().default("")
    })
    const r = parseEnv(Schema, { LOG_LEVEL: "", PORT: "", PREFIX: "" })
    expect(r).toEqual({ ok: true, value: { LOG_LEVEL: undefined, PORT: 3000, PREFIX: "" } })
  })

  // Issue #56: `FOO= ` or `FOO="  "` is a typo, not a value; z.coerce.number() turns " " into 0.
  it("treats a whitespace-only value as unset too", () => {
    const Schema = z.object({ PORT: z.coerce.number().default(3000), NAME: z.string().optional() })
    expect(parseEnv(Schema, { PORT: " ", NAME: "\t\n " })).toEqual({ ok: true, value: { PORT: 3000, NAME: undefined } })
  })

  it("keeps surrounding whitespace on a value that has other characters", () => {
    expect(parseEnv(z.object({ SEP: z.string() }), { SEP: " , " })).toEqual({ ok: true, value: { SEP: " , " } })
  })

  it("a required var set to \"\" fails as missing", () => {
    const r = parseEnv(z.object({ DATABASE_URL: z.string() }), { DATABASE_URL: "" })
    if (r.ok) throw new Error("expected Err")
    expect(r.error.issues.map((i) => [...i.path])).toEqual([["DATABASE_URL"]])
  })

  it("does not mutate the record it was given", () => {
    const env = { A: "" }
    parseEnv(z.object({ A: z.string().optional() }), env)
    expect(env).toEqual({ A: "" })
  })
})

// Spec #30 story 28: the documented boolean recipes (module doc) instead of z.coerce.boolean(),
// which is JS truthiness ("false" -> true).
describe("parseEnv strict booleans (documented recipes)", () => {
  const recipes = [
    ["zod stringbool", z.object({ DEBUG: z.stringbool().default(false) })],
    [
      "valibot picklist + transform",
      v.object({
        DEBUG: v.optional(
          v.pipe(v.picklist(["true", "false", "1", "0"]), v.transform((s) => s === "true" || s === "1")),
          "false"
        )
      })
    ]
  ] as const

  it.each(recipes)("%s: \"false\"/\"0\" -> false, \"true\"/\"1\" -> true, unset or \"\" -> false", (_name, schema) => {
    const debug = (DEBUG?: string): unknown => {
      const r = parseEnv(schema, DEBUG === undefined ? {} : { DEBUG })
      return r.ok ? r.value.DEBUG : r.error
    }
    expect([debug("false"), debug("0"), debug("true"), debug("1"), debug(), debug("")]).toEqual([
      false,
      false,
      true,
      true,
      false,
      false
    ])
  })

  it.each(recipes)("%s: anything else is an issue, not true", (_name, schema) => {
    const r = parseEnv(schema, { DEBUG: "maybe" })
    expect(r.ok).toBe(false)
  })
})

// Spec #30 story 27: edge runtimes have no `process` global.
describe("parseEnv default source", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("without a process global, validates an empty record instead of throwing", () => {
    vi.stubGlobal("process", undefined)
    const r = parseEnv(z.object({ PORT: z.coerce.number().default(3000) }))
    expect(r).toEqual({ ok: true, value: { PORT: 3000 } })
  })

  it("reads the live process.env when it exists", () => {
    vi.stubEnv("FL_ENV_TEST_VAR", "from-process")
    const r = parseEnv(z.object({ FL_ENV_TEST_VAR: z.string() }))
    expect(r).toEqual({ ok: true, value: { FL_ENV_TEST_VAR: "from-process" } })
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

// Ticket #34: Result constructors come from core, not re-exported here.
describe("public surface", () => {
  it("exports only parseEnv and envRecord at runtime", async () => {
    const mod = await import("@friday-friday/env")
    expect(Object.keys(mod).toSorted()).toEqual(["envRecord", "parseEnv"])
  })
})
