import { type Err, err, type Ok, ok } from "@friday-friday/core"
import { expectTypeOf, test } from "vitest"

// Compile-time only: picked up by `vitest --typecheck` (ADR-0004).
test("constructors infer precise types", () => {
  expectTypeOf(ok(1)).toEqualTypeOf<Ok<number>>()
  expectTypeOf(err("e" as const)).toEqualTypeOf<Err<"e">>()
})
