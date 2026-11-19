/**
 * The fixed vocabulary (ADR-0005, #87): core's root owns one factory per fixed tag except
 * `ValidationFailure` (schema owns it). Every prop is optional and JSON-safe; `/async`'s `Timeout`
 * is core root's `Timeout`; `/wire`'s default status table is built from the factories' `.tag`.
 */
import {
  Conflict,
  DbUnavailable,
  Forbidden,
  NetworkError,
  NotFound,
  Timeout,
  Unauthenticated
} from "@friday-friday/core"
import { Timeout as AsyncTimeout, timeout } from "@friday-friday/core/async"
import { fromWire, toProblem } from "@friday-friday/core/wire"
import { describe, expect, it } from "vitest"

/** Each factory, the tag it must own, and one value for every optional prop it declares. */
const vocabulary = [
  [NotFound, "NotFound", { resource: "user", id: "42" }],
  [Conflict, "Conflict", { field: "email", constraint: "users_email_key" }],
  [Forbidden, "Forbidden", { required: "admin" }],
  [Unauthenticated, "Unauthenticated", {}],
  [Timeout, "Timeout", { ms: 500 }],
  [NetworkError, "NetworkError", { reason: "ECONNRESET" }],
  [DbUnavailable, "DbUnavailable", {}]
] as const

describe("core root exports the fixed-vocabulary factories (ADR-0005)", () => {
  it.each(vocabulary)("%#: owns its tag", (factory, tag) => {
    expect(factory.tag).toBe(tag)
  })

  it.each(vocabulary)("%#: every prop is optional: {} builds { _tag } and nothing else", (factory, tag) => {
    expect(factory({})).toStrictEqual({ _tag: tag })
  })

  it.each(vocabulary)("%#: carries its props and message as plain, JSON-safe data", (factory, tag, props) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the union of factories takes the intersection of their props; each row's props match its own factory (type tests check each one)
    const e = (factory as (p: object) => object)({ ...props, message: "m" })
    expect(e).toStrictEqual({ _tag: tag, ...props, message: "m" })
    expect(JSON.parse(JSON.stringify(e))).toStrictEqual(e)
    expect(structuredClone(e)).toStrictEqual(e)
  })

  it.each(vocabulary)("%#: is() is structural and checks only the tag", (factory, tag) => {
    expect(factory.is({ _tag: tag })).toBe(true)
    expect(factory.is(JSON.parse(JSON.stringify(factory({}))))).toBe(true)
    expect(factory.is({ _tag: `${tag}x` })).toBe(false)
  })

  it("the seven tags are distinct", () => {
    expect(new Set(vocabulary.map(([f]) => f.tag)).size).toBe(7)
  })
})

describe("/async's Timeout is core root's Timeout (expand step of #66)", () => {
  it("is the same value", () => {
    expect(AsyncTimeout).toBe(Timeout)
  })

  it("timeout() produces it", async () => {
    const r = await timeout(() => new Promise<never>(() => {}), 10)
    expect(r).toStrictEqual({ ok: false, error: Timeout({ ms: 10 }) })
    expect(!r.ok && Timeout.is(r.error)).toBe(true)
  })
})

describe("/wire default statuses for the infrastructure tags (ADR-0005)", () => {
  it.each([
    [DbUnavailable({}), 503],
    [Timeout({ ms: 500 }), 504],
    [NetworkError({ reason: "ECONNRESET" }), 502]
  ])("%o → %i with no status map", (e, status) => {
    const p = toProblem(e)
    expect(p.status).toBe(status)
    expect(p.tag).toBe(e._tag)
    expect(toProblem(e, { NotFound: 404 }).status).toBe(status) // defaults fill gaps in a map
  })

  it("the domain defaults are unchanged", () => {
    expect([NotFound, Forbidden, Unauthenticated, Conflict].map((f) => toProblem(f({})).status)).toStrictEqual([
      404,
      403,
      401,
      409
    ])
  })

  it("strict is unchanged: an infrastructure tag missing from the caller's map is masked", () => {
    for (const e of [DbUnavailable({}), Timeout({ ms: 1 }), NetworkError({ reason: "x" })]) {
      expect(toProblem(e, {}, { strict: true }).tag).toBe("InternalDefect")
      expect(toProblem(e, { [e._tag]: 500 }, { strict: true }).tag).toBe(e._tag)
    }
  })

  it("parse-back of a tag-less problem stays domain-only: 502/503/504 are not attributed", () => {
    for (const status of [502, 503, 504]) expect(fromWire({ status, title: "x" })).toBeUndefined()
  })
})
