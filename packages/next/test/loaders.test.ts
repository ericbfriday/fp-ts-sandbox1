/**
 * Loader runtime tests (Design Report §5.1 "RSC loaders") against the REAL `next/navigation`.
 *
 * No mock: each loader must raise Next's own sentinel, identified by its `digest` (the field
 * Next's boundaries and `unstable_rethrow` read), never by `message`.
 */
import { Conflict, err, NotFound, ok, type Result, taggedError } from "@friday-friday/core"
import { orForbidden, orNotFound, orRedirect } from "@friday-friday/next"
import { afterEach, describe, expect, it, vi } from "vitest"

const Forbidden = taggedError("Forbidden")<{ action?: string }>()
const Unauthenticated = taggedError("Unauthenticated")<{ where?: string }>()

/** The digest of whatever `fn` throws; fails the test if it returns normally. */
const digestOf = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return typeof e === "object" && e !== null && "digest" in e ? e.digest : undefined
  }
  return expect.unreachable("expected a Next sentinel to be thrown")
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("orNotFound", () => {
  it("raises Next's 404 sentinel for the NotFound tag", () => {
    expect(digestOf(() => orNotFound(err(NotFound({ id: "1" }))))).toBe("NEXT_HTTP_ERROR_FALLBACK;404")
  })

  it("returns Ok and other tags as the same Result", () => {
    const fine = ok("fine")
    const conflict = err(Conflict({ field: "name" }))
    expect(orNotFound(fine)).toBe(fine)
    expect(orNotFound(conflict)).toBe(conflict)
  })
})

describe("orForbidden", () => {
  it("raises Next's 403 sentinel for the Forbidden tag (experimental.authInterrupts on)", () => {
    // next.config's experimental.authInterrupts sets this env var; forbidden() refuses without it.
    vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true")
    expect(digestOf(() => orForbidden(err(Forbidden({ action: "edit" }))))).toBe("NEXT_HTTP_ERROR_FALLBACK;403")
  })

  it("returns Ok and other tags as the same Result", () => {
    const fine = ok(1)
    const missing = err(NotFound({ id: "1" }))
    expect(orForbidden(fine)).toBe(fine)
    expect(orForbidden(missing)).toBe(missing)
  })
})

describe("orRedirect", () => {
  it("raises Next's redirect sentinel to `to` for the Unauthenticated tag", () => {
    const digest = digestOf(() => orRedirect(err(Unauthenticated({ where: "page" })), "/login"))
    // Digest layout: NEXT_REDIRECT;<type>;<url>;<status>;
    expect(typeof digest === "string" ? digest.split(";") : digest).toEqual([
      "NEXT_REDIRECT",
      "replace",
      "/login",
      "307",
      ""
    ])
  })

  it("returns Ok and other tags as the same Result", () => {
    const fine = ok(1)
    const forbidden = err(Forbidden({ action: "edit" }))
    expect(orRedirect(fine, "/login")).toBe(fine)
    expect(orRedirect(forbidden, "/login")).toBe(forbidden)
  })
})

describe("composed loaders", () => {
  it("each loader fires only for its own tag", () => {
    vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true")
    const load = (r: Result<number, ReturnType<typeof NotFound> | ReturnType<typeof Forbidden>>): unknown =>
      digestOf(() => orRedirect(orForbidden(orNotFound(r)), "/login"))
    expect(load(err(NotFound({ id: "1" })))).toBe("NEXT_HTTP_ERROR_FALLBACK;404")
    expect(load(err(Forbidden({ action: "edit" })))).toBe("NEXT_HTTP_ERROR_FALLBACK;403")
  })
})
