/**
 * `/gen` subpath tests (RFC-0001 §4 / Design Report §3.5).
 */
import { andThen, err, ok, Panic, pipe, taggedError, type AsyncResult, type Result } from "@friday-friday/core"
import { $, gen, genAsync } from "@friday-friday/core/gen"
import { describe, expect, it } from "vitest"

const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundT = ReturnType<typeof NotFound>

describe("gen (sync do-notation)", () => {
  it("is equivalent to the manual andThen chain (RFC AC)", () => {
    const findUser = (id: string): Result<{ profile: string }, NotFoundT> =>
      id === "1" ? ok({ profile: "admin" }) : err(NotFound({ id }))
    const viaChain = pipe(findUser("1"), andThen((u) => ok(u.profile)))
    const viaGen = gen(function* () {
      const u = yield* $(findUser("1"))
      return u.profile
    })
    expect(viaGen).toEqual(viaChain)
    expect(viaGen).toEqual(ok("admin"))
  })

  it("short-circuits on the first Err, preserving the envelope identity", () => {
    const e = err(NotFound({ id: "9" }))
    let afterRan = false
    const r = gen(function* () {
      const never = yield* $(e)
      afterRan = true
      return ok(never)
    })
    expect(afterRan).toBe(false)
    expect(r).toBe(e) // same envelope object, not a copy
  })

  it("returns the last Ok through multiple steps", () => {
    const r = gen(function* () {
      const a = yield* $(ok(1))
      const b = yield* $(ok(2))
      return a + b
    })
    expect(r).toEqual(ok(3))
  })

  it("wraps a throwing generator body as Panic with the original as cause", () => {
    const boom = new Error("boom")
    let caught: unknown
    try {
      gen(function* () {
        if (boom) throw boom
        return "never"
      })
    } catch (e) {
      caught = e
    }
    if (!(caught instanceof Panic)) throw new Error("expected Panic")
    expect(caught.cause).toBe(boom)
  })

  it("outputs are plain data (JSON + structuredClone)", () => {
    const r = gen(function* () {
      const a = yield* $(ok({ id: 1 }))
      return { a }
    })
    expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r)
    expect(structuredClone(r)).toStrictEqual(r)
  })
})

describe("genAsync (async do-notation)", () => {
  const findProfile = (id: string): AsyncResult<string, { readonly _tag: "NotFound"; readonly id: string }> =>
    Promise.resolve(id === "1" ? ok("admin") : err({ _tag: "NotFound", id }))

  it("awaits and chains async steps", async () => {
    const r = await genAsync(async function* () {
      const id = yield* $(await Promise.resolve(ok("1")))
      const profile = yield* $(await findProfile(id))
      return profile
    })
    expect(r).toEqual(ok("admin"))
  })

  it("short-circuits on Err without running later steps", async () => {
    let afterRan = false
    const r = await genAsync(async function* () {
      yield* $(await Promise.resolve(err(NotFound({ id: "9" }))))
      afterRan = true
      return "never"
    })
    expect(afterRan).toBe(false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toEqual({ _tag: "NotFound", id: "9" })
  })

  it("wraps rejections as Panic", async () => {
    const boom = new Error("boom")
    await expect(
      genAsync(async function* () {
        throw boom
      })
    ).rejects.toThrow(Panic)
  })

  it("outputs are plain data (JSON + structuredClone)", async () => {
    const r = await genAsync(async function* () {
      const v = yield* $(await Promise.resolve(ok({ deep: { id: 1 } })))
      return { v }
    })
    expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r)
    expect(structuredClone(r)).toStrictEqual(r)
  })
})

describe("$ wrapper misuse", () => {
  it("throws if a $() iterator is manually resumed after yielding", () => {
    const wrapped = $(err("x") as Result<never, string>)
    const it = wrapped[Symbol.iterator]()
    const first = it.next()
    expect(first.done).toBe(false)
    expect(() => it.next()).toThrow(/resumed after yielding/)
  })
})
