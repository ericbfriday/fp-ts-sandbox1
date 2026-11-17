/**
 * `@friday-friday/tanstack-start` type tests.
 *
 * Note: E-inference through resultHandler widens to the TaggedError constraint when the
 * handler return is annotated (TS quirk, also seen in query/matchTag) - the error channel
 * itself is pinned by the runtime tests, which exercise ValidationFailure and domain
 * errors as data on the real schema path.
 */
import { resultHandler } from "@friday-friday/tanstack-start"
import { describe, expectTypeOf, it } from "vitest"
import { z } from "zod"

const PostSchema = z.object({ title: z.string(), body: z.string() })

describe("resultHandler", () => {
  it("handler input is the schema output; ok value flows to the data channel", async () => {
    const h = resultHandler(PostSchema, async (input: { title: string; body: string }) => {
      expectTypeOf(input).toEqualTypeOf<{ title: string; body: string }>()
      return { ok: true as const, value: input.title }
    })
    const r = await h({ data: { title: "t", body: "b" } })
    if (r.ok) {
      expectTypeOf(r.value).toEqualTypeOf<string>()
    } else {
      // Err arm exists and carries a tagged error (ValidationFailure or E).
      expectTypeOf(r.error._tag).toBeString()
    }
  })
})
