/**
 * `@friday-friday/next` type tests (Design Report §5.1 / RFC-0001 §6).
 *
 * Pattern: annotated-const assignments are the real inference assertions (see async.test-d.ts).
 */
import { type AsyncResult, err, matchTag, ok, type Result, taggedError } from "@friday-friday/core"
import {
  action,
  type ActionState,
  orForbidden,
  orNotFound,
  orRedirect,
  toResponse,
  tryAsync
} from "@friday-friday/next"
import { describe, expectTypeOf, test } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundT = ReturnType<typeof NotFound>
const Conflict = taggedError("Conflict")<{ field: string }>()
type ConflictT = ReturnType<typeof Conflict>
const Forbidden = taggedError("Forbidden")()
type ForbiddenT = ReturnType<typeof Forbidden>
const Unauthenticated = taggedError("Unauthenticated")<{ where: string }>()
type UnauthenticatedT = ReturnType<typeof Unauthenticated>

// Inputs are declared (not inferred from a literal) so E is the full union under test.
// Outputs are asserted on the call itself: no annotated const, so `any` or a widened E fails.
declare const loaded: Result<number, NotFoundT | ConflictT>
declare const authed: Result<number, NotFoundT | UnauthenticatedT>
declare const guarded: Result<number, NotFoundT | ForbiddenT | UnauthenticatedT | ConflictT>

describe("next types", () => {
  test("tryAsync maps via the catch handler", () => {
    const r: AsyncResult<number, NotFoundT> = tryAsync(async () => 1, { catch: () => NotFound({ id: "1" }) })
    expectTypeOf(r).toEqualTypeOf<AsyncResult<number, NotFoundT>>()
  })

  test("toResponse takes the status map and returns a Response", () => {
    const r: Result<string, NotFoundT> = err(NotFound({ id: "1" }))
    const res: Response = toResponse(r, { NotFound: 404 })
    expectTypeOf(res).toEqualTypeOf<Response>()
  })

  test("orNotFound removes NotFound from E", () => {
    expectTypeOf(orNotFound(loaded)).toEqualTypeOf<Result<number, ConflictT>>()
  })

  test("orForbidden removes Forbidden from E", () => {
    expectTypeOf(orForbidden(guarded)).toEqualTypeOf<
      Result<number, NotFoundT | UnauthenticatedT | ConflictT>
    >()
  })

  test("orRedirect removes Unauthenticated from E", () => {
    expectTypeOf(orRedirect(guarded, "/login")).toEqualTypeOf<Result<number, NotFoundT | ForbiddenT | ConflictT>>()
  })

  test("loaders compose: each removes only its own tag", () => {
    expectTypeOf(orRedirect(orForbidden(orNotFound(guarded)), "/login")).toEqualTypeOf<Result<number, ConflictT>>()
  })

  test("a Result with no loader tag passes through with E unchanged", () => {
    expectTypeOf(orNotFound(ok("x"))).toEqualTypeOf<Result<string, never>>()
    expectTypeOf(orNotFound(err(Conflict({ field: "f" })))).toEqualTypeOf<Result<never, ConflictT>>()
  })

  test("a union argument (guard ? load : err) keeps every Err member in E", () => {
    const pick = (signedIn: boolean) => signedIn ? loaded : err(Unauthenticated({ where: "page" }))
    expectTypeOf(orNotFound(pick(true))).toEqualTypeOf<Result<number, ConflictT | UnauthenticatedT>>()
  })

  test("matchTag over the narrowed Result is exhaustive without the removed tag", () => {
    expectTypeOf(matchTag(orNotFound(loaded), { ok: (n) => n, Conflict: (e) => e.field })).toEqualTypeOf<
      number | string
    >()
    // Once every loader tag is gone, `ok` alone is exhaustive.
    expectTypeOf(matchTag(orRedirect(orNotFound(authed), "/login"), { ok: (n) => n })).toEqualTypeOf<number>()
    // The remaining tag is still required.
    // @ts-expect-error: missing the Conflict handler
    matchTag(orNotFound(loaded), { ok: (n) => n })
  })

  test("action returns the ActionState union with ValidationFailure + InternalDefect", async () => {
    const Profile = z.object({ name: z.string() })
    const save = action(Profile, async (input) => ok(input.name))
    const state: ActionState<string, never> = await save({ ok: null }, new FormData())
    expectTypeOf(state).toEqualTypeOf<ActionState<string, never>>()
  })
})
