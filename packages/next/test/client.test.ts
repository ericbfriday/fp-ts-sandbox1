// @vitest-environment happy-dom
/**
 * `@friday-friday/next/client` (#53, Design Report §5.1 "Client"): the boundary helpers cover
 * errors thrown IN THE BROWSER only. A server-thrown error reaches the client as a digest
 * (production) or name/message/stack (development) — see flight.test.ts — so it never decodes.
 *
 * Rendered with the real react-dom client and the real `catchError` from `next/error`.
 */
import { err, NotFound, ok, type Result } from "@friday-friday/core"
import { type BoundaryProps, orThrow, resultBoundary } from "@friday-friday/next/client"
import { Window } from "happy-dom"
import { act, createElement, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest" // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- React's documented act() flag
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let unmount: (() => void) | undefined
afterEach(() => {
  act(() => unmount?.())
  unmount = undefined
})

/** Render `child` inside a `resultBoundary` and return the props its fallback saw (or undefined). */
const caught = (child: () => ReactNode): BoundaryProps | undefined => {
  let seen: BoundaryProps | undefined
  const Boundary = resultBoundary((props) => {
    seen = props
    return createElement("p", null, props.tagged?._tag ?? "untagged")
  })
  const root = createRoot(new Window().document.createElement("div"), { onCaughtError: () => {} })
  act(() => root.render(createElement(Boundary, null, createElement(child))))
  unmount = () => root.unmount()
  return seen
}

describe("orThrow (client components)", () => {
  it("returns the value of an Ok", () => {
    expect(orThrow(ok(42))).toBe(42)
  })

  it("throws an Err as toThrowable's Error: name is the tag, data the error, no cause", () => {
    const e = NotFound({ id: "1", message: "gone", cause: new Error("db") })
    const r: Result<number, NotFound> = err(e)
    let thrown: unknown
    try {
      orThrow(r)
    } catch (x) {
      thrown = x
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toMatchObject({ name: "NotFound", message: "gone", data: e })
    expect(typeof thrown === "object" && thrown !== null && "cause" in thrown).toBe(false)
  })
})

describe("resultBoundary (client-thrown errors only)", () => {
  it("decodes a tagged error thrown by orThrow in a client component", () => {
    const e = NotFound({ id: "7" })
    const seen = caught(() => orThrow(err(e)))
    expect(seen?.tagged).toBe(e)
    expect(NotFound.is(seen?.tagged)).toBe(true)
    expect(seen?.error).toMatchObject({ name: "NotFound", data: e })
  })

  it("decodes a plain tagged error thrown as-is (e.g. a suspense query's toQueryFn error)", () => {
    const e = NotFound({ id: "8" })
    const seen = caught(() => {
      throw e
    })
    expect(seen?.tagged).toBe(e)
    expect(seen?.error).toBe(e)
  })

  it("leaves tagged undefined for an untagged throw", () => {
    const boom = new Error("boom")
    const seen = caught(() => {
      throw boom
    })
    expect(seen).toEqual({ error: boom, tagged: undefined })
  })

  it("leaves tagged undefined for what a server-thrown error becomes on the client (digest only)", () => {
    const fromServer = Object.assign(new Error("An error occurred in the Server Components render."), {
      digest: "123"
    })
    const seen = caught(() => {
      throw fromServer
    })
    expect(seen?.tagged).toBeUndefined()
  })

  it("renders its children when nothing throws", () => {
    const seen = caught(() => createElement("span", null, "fine"))
    expect(seen).toBeUndefined()
  })
})

describe("resultBoundary decoding", () => {
  it("ignores a data attachment whose _tag is not a string", () => {
    const seen = caught(() => {
      throw Object.assign(new Error("x"), { data: { _tag: 1 } })
    })
    expect(seen?.tagged).toBeUndefined()
  })
})
