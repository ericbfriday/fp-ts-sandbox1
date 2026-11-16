/**
 * `@friday-friday/next` type tests (Design Report §5.1 / RFC-0001 §6).
 *
 * Pattern: annotated-const assignments are the real inference assertions (see async.test-d.ts).
 */
import { type AsyncResult, err, ok, type Result, type TaggedError, taggedError } from "@friday-friday/core"
import { action, type ActionState, orNotFound, toResponse, tryAsync } from "@friday-friday/next"
import { describe, expectTypeOf, test } from "vitest"
import { z } from "zod"

const NotFound = taggedError("NotFound")<{ id: string }>()
type NotFoundT = ReturnType<typeof NotFound>

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

  test("orNotFound passes Ok through unchanged", () => {
    const r: Result<string, TaggedError<string>> = ok("x")
    const out: Result<string, TaggedError<string>> = orNotFound(r)
    expectTypeOf(out).toEqualTypeOf<Result<string, TaggedError<string>>>()
  })

  test("action returns the ActionState union with ValidationFailure + InternalDefect", async () => {
    const Profile = z.object({ name: z.string() })
    const save = action(Profile, async (input) => ok(input.name))
    const state: ActionState<string, never> = await save({ ok: null }, new FormData())
    expectTypeOf(state).toEqualTypeOf<ActionState<string, never>>()
  })
})
