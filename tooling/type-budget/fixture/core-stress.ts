/**
 * Type-instantiation budget fixture (IDEA §8, ADR-0004, #61): the heaviest inference shapes core
 * promises to handle, at the arities the overloads cap (DEVELOPER.md: `pipe`/`flow` are explicit
 * overloads, never recursive types). `src/check.ts` runs `tsc --extendedDiagnostics` on this file
 * and on `core-baseline.ts`, and fails when the difference passes the ceiling in `budget.json`.
 *
 * Promoted from the 2026-11-18 explorer pass (#51). Edit it only together with a re-measured
 * budget: the recorded numbers are for exactly these call sites.
 */
import { all, andThen, flow, matchTag, ok, pipe, type Result, taggedError } from "@friday-friday/core"

// Fifteen fallible steps, each with its own tagged error, so E grows to a 15-member union.
const E0 = taggedError("E0")<{ n: 0 }>()
declare const s0: (x: number) => Result<number, ReturnType<typeof E0>>
const E1 = taggedError("E1")<{ n: 1 }>()
declare const s1: (x: number) => Result<number, ReturnType<typeof E1>>
const E2 = taggedError("E2")<{ n: 2 }>()
declare const s2: (x: number) => Result<number, ReturnType<typeof E2>>
const E3 = taggedError("E3")<{ n: 3 }>()
declare const s3: (x: number) => Result<number, ReturnType<typeof E3>>
const E4 = taggedError("E4")<{ n: 4 }>()
declare const s4: (x: number) => Result<number, ReturnType<typeof E4>>
const E5 = taggedError("E5")<{ n: 5 }>()
declare const s5: (x: number) => Result<number, ReturnType<typeof E5>>
const E6 = taggedError("E6")<{ n: 6 }>()
declare const s6: (x: number) => Result<number, ReturnType<typeof E6>>
const E7 = taggedError("E7")<{ n: 7 }>()
declare const s7: (x: number) => Result<number, ReturnType<typeof E7>>
const E8 = taggedError("E8")<{ n: 8 }>()
declare const s8: (x: number) => Result<number, ReturnType<typeof E8>>
const E9 = taggedError("E9")<{ n: 9 }>()
declare const s9: (x: number) => Result<number, ReturnType<typeof E9>>
const E10 = taggedError("E10")<{ n: 10 }>()
declare const s10: (x: number) => Result<number, ReturnType<typeof E10>>
const E11 = taggedError("E11")<{ n: 11 }>()
declare const s11: (x: number) => Result<number, ReturnType<typeof E11>>
const E12 = taggedError("E12")<{ n: 12 }>()
declare const s12: (x: number) => Result<number, ReturnType<typeof E12>>
const E13 = taggedError("E13")<{ n: 13 }>()
declare const s13: (x: number) => Result<number, ReturnType<typeof E13>>
const E14 = taggedError("E14")<{ n: 14 }>()
declare const s14: (x: number) => Result<number, ReturnType<typeof E14>>

// 15-step `andThen` pipe (pipe's 16-arity overload).
export const p = pipe(
  ok(1) as Result<number>,
  andThen(s0),
  andThen(s1),
  andThen(s2),
  andThen(s3),
  andThen(s4),
  andThen(s5),
  andThen(s6),
  andThen(s7),
  andThen(s8),
  andThen(s9),
  andThen(s10),
  andThen(s11),
  andThen(s12),
  andThen(s13),
  andThen(s14)
)
// 15-tag `matchTag`, data-first and data-last.
export const m = matchTag(p, {
  ok: () => -1,
  E0: () => 0,
  E1: () => 1,
  E2: () => 2,
  E3: () => 3,
  E4: () => 4,
  E5: () => 5,
  E6: () => 6,
  E7: () => 7,
  E8: () => 8,
  E9: () => 9,
  E10: () => 10,
  E11: () => 11,
  E12: () => 12,
  E13: () => 13,
  E14: () => 14
})
export const m2 = pipe(
  p,
  matchTag({
    ok: (v) => v,
    E0: () => 0,
    E1: () => 1,
    E2: () => 2,
    E3: () => 3,
    E4: () => 4,
    E5: () => 5,
    E6: () => 6,
    E7: () => 7,
    E8: () => 8,
    E9: () => 9,
    E10: () => 10,
    E11: () => 11,
    E12: () => 12,
    E13: () => 13,
    E14: () => 14
  })
)
// 12-tuple `all`.
export const a = all([s0(1), s1(1), s2(1), s3(1), s4(1), s5(1), s6(1), s7(1), s8(1), s9(1), s10(1), s11(1)])
// 11-step `flow`.
export const f = flow(
  s0,
  andThen(s1),
  andThen(s2),
  andThen(s3),
  andThen(s4),
  andThen(s5),
  andThen(s6),
  andThen(s7),
  andThen(s8),
  andThen(s9),
  andThen(s10)
)
