import {
  all,
  andThen,
  type AsyncResult,
  type Err,
  err,
  type ErrorFactory,
  flow,
  fromNullable,
  isResult,
  map,
  mapErr,
  match,
  matchTag,
  type Ok,
  ok,
  orElse,
  partition,
  pipe,
  type Result,
  type TaggedError,
  tap,
  tapErr,
  type Throwable,
  toThrowable,
  unwrapOr
} from "@friday-friday/core"
import { describe, expectTypeOf, test } from "vitest"
import { Forbidden, NotFound } from "./_fixtures.js"

// Compile-time only: picked up by `vitest --typecheck` (ADR-0004) and by `tsc -p tsconfig.json`.

declare const numOrStr: Result<number, string>
declare const numOrTagged: Result<number, NotFound | Forbidden>

describe("constructors and guards", () => {
  test("ok / err infer precise types; E defaults to never", () => {
    expectTypeOf(ok(1)).toEqualTypeOf<Ok<number>>()
    expectTypeOf(err("e" as const)).toEqualTypeOf<Err<"e">>()
    expectTypeOf<Result<number>>().toEqualTypeOf<Ok<number> | Err<never>>()
    expectTypeOf<AsyncResult<number, string>>().toEqualTypeOf<Promise<Result<number, string>>>()
  })

  test("Result is covariant in both parameters", () => {
    expectTypeOf<Result<1, "a">>().toMatchTypeOf<Result<number, "a" | "b">>()
    expectTypeOf<Ok<number>>().toMatchTypeOf<Result<number, string>>()
  })

  test("isResult narrows unknown", () => {
    const u: unknown = null
    if (isResult(u)) {
      expectTypeOf(u).toEqualTypeOf<Result<unknown, unknown>>()
      if (u.ok) expectTypeOf(u.value).toBeUnknown()
      else expectTypeOf(u.error).toBeUnknown()
    }
  })

  test("narrowing on ok", () => {
    if (numOrStr.ok) expectTypeOf(numOrStr.value).toEqualTypeOf<number>()
    else expectTypeOf(numOrStr.error).toEqualTypeOf<string>()
  })
})

describe("tagged errors", () => {
  test("factory + ReturnType twin type", () => {
    expectTypeOf(NotFound).toEqualTypeOf<ErrorFactory<"NotFound", { resource: string; id: string }>>()
    expectTypeOf(NotFound.tag).toEqualTypeOf<"NotFound">()
    expectTypeOf<NotFound>().toEqualTypeOf<TaggedError<"NotFound"> & Readonly<{ resource: string; id: string }>>()
    const e = NotFound({ resource: "user", id: "1", message: "m", cause: new Error("x") })
    expectTypeOf(e._tag).toEqualTypeOf<"NotFound">()
    expectTypeOf(e.id).toEqualTypeOf<string>()
    expectTypeOf(e.message).toEqualTypeOf<string | undefined>()
    // @ts-expect-error props are required
    NotFound({ resource: "user" })
  })

  test("a _tag prop is rejected, even when spread in (#60: the factory owns _tag)", () => {
    const conflict = { _tag: "Conflict" as const, resource: "user", id: "1" }
    // @ts-expect-error a spread hides `_tag` from excess-property checks; `_tag?: never` still rejects it
    NotFound({ ...conflict })
    // @ts-expect-error a literal `_tag` is rejected too, even the factory's own tag
    NotFound({ _tag: "NotFound", resource: "user", id: "1" })
    // @ts-expect-error a whole tagged error passed as props
    NotFound(NotFound({ resource: "user", id: "1" }))
  })

  test("is() narrows unknown and the E of a Result", () => {
    const u: unknown = null
    if (NotFound.is(u)) expectTypeOf(u).toEqualTypeOf<NotFound>()
    if (!numOrTagged.ok && NotFound.is(numOrTagged.error)) {
      expectTypeOf(numOrTagged.error).toEqualTypeOf<NotFound>()
    }
  })

  test("toThrowable keeps the tag on name and the error on data", () => {
    const t = toThrowable(NotFound({ resource: "user", id: "1" }))
    expectTypeOf(t).toEqualTypeOf<Throwable<NotFound>>()
    expectTypeOf(t).toMatchTypeOf<Error>()
    expectTypeOf(t.name).toEqualTypeOf<"NotFound">()
    expectTypeOf(t.data).toEqualTypeOf<NotFound>()
  })
})

describe("dual overloads infer correctly", () => {
  test("map", () => {
    expectTypeOf(map(numOrStr, (n) => String(n))).toEqualTypeOf<Result<string, string>>()
    expectTypeOf(map(ok(1), (n) => String(n))).toEqualTypeOf<Result<string, never>>()
    expectTypeOf(pipe(numOrStr, map((n) => String(n)))).toEqualTypeOf<Result<string, string>>()
    expectTypeOf(pipe(ok(1), map((n) => n + 1))).toEqualTypeOf<Result<number, never>>()
    pipe(numOrStr, map((n) => expectTypeOf(n).toEqualTypeOf<number>()))
    const inc = map((n: number) => n + 1)
    expectTypeOf(inc(numOrStr)).toEqualTypeOf<Result<number, string>>()
  })

  test("mapErr", () => {
    expectTypeOf(mapErr(numOrStr, (e) => e.length)).toEqualTypeOf<Result<number, number>>()
    expectTypeOf(pipe(numOrStr, mapErr((e) => e.length))).toEqualTypeOf<Result<number, number>>()
    pipe(numOrStr, mapErr((e) => expectTypeOf(e).toEqualTypeOf<string>()))
  })

  test("andThen", () => {
    const toTagged = (n: number): Result<boolean, NotFound> =>
      n > 0 ? ok(true) : err(NotFound({ resource: "n", id: "0" }))
    expectTypeOf(andThen(numOrStr, toTagged)).toEqualTypeOf<Result<boolean, string | NotFound>>()
    expectTypeOf(pipe(numOrStr, andThen(toTagged))).toEqualTypeOf<Result<boolean, string | NotFound>>()
    expectTypeOf(andThen(ok(1), (n) => ok(String(n)))).toEqualTypeOf<Result<string, never>>()
    pipe(numOrStr, andThen((n) => ok(expectTypeOf(n).toEqualTypeOf<number>())))
  })

  test("orElse", () => {
    const recover = (e: string): Result<"fallback", Forbidden> => e ? ok("fallback") : err(Forbidden({ reason: e }))
    expectTypeOf(orElse(numOrStr, recover)).toEqualTypeOf<Result<number | "fallback", Forbidden>>()
    expectTypeOf(pipe(numOrStr, orElse(recover))).toEqualTypeOf<Result<number | "fallback", Forbidden>>()
    expectTypeOf(orElse(numOrStr, () => ok(0))).toEqualTypeOf<Result<number, never>>()
  })

  test("tap / tapErr keep the Result type", () => {
    expectTypeOf(tap(numOrStr, (n) => expectTypeOf(n).toEqualTypeOf<number>())).toEqualTypeOf<Result<number, string>>()
    expectTypeOf(pipe(numOrStr, tap((n) => expectTypeOf(n).toEqualTypeOf<number>()))).toEqualTypeOf<
      Result<number, string>
    >()
    expectTypeOf(tapErr(numOrStr, (e) => expectTypeOf(e).toEqualTypeOf<string>())).toEqualTypeOf<
      Result<number, string>
    >()
    expectTypeOf(pipe(numOrStr, tapErr((e) => expectTypeOf(e).toEqualTypeOf<string>()))).toEqualTypeOf<
      Result<number, string>
    >()
  })

  test("unwrapOr", () => {
    expectTypeOf(unwrapOr(numOrStr, null)).toEqualTypeOf<number | null>()
    expectTypeOf(pipe(numOrStr, unwrapOr(null))).toEqualTypeOf<number | null>()
    expectTypeOf(unwrapOr(numOrStr, 0)).toEqualTypeOf<number>()
  })

  test("match", () => {
    const handlers = { ok: (n: number): string => String(n), err: (e: string): boolean => e.length > 0 }
    expectTypeOf(match(numOrStr, handlers)).toEqualTypeOf<string | boolean>()
    expectTypeOf(pipe(numOrStr, match(handlers))).toEqualTypeOf<string | boolean>()
    pipe(
      numOrStr,
      match({
        ok: (n) => expectTypeOf(n).toEqualTypeOf<number>(),
        err: (e) => expectTypeOf(e).toEqualTypeOf<string>()
      })
    )
  })

  test("fromNullable strips null/undefined and types the error lazily", () => {
    const maybe: string | null | undefined = "x"
    const onNone = (): NotFound => NotFound({ resource: "s", id: "1" })
    expectTypeOf(fromNullable(maybe, onNone)).toEqualTypeOf<Result<string, NotFound>>()
    expectTypeOf(pipe(maybe, fromNullable(onNone))).toEqualTypeOf<Result<string, NotFound>>()
  })
})

describe("matchTag is exhaustive over _tag", () => {
  const handlers = {
    ok: (n: number): string => String(n),
    NotFound: (e: NotFound): number => e.id.length,
    Forbidden: (e: Forbidden): boolean => e.reason.length > 0
  }

  test("return type is the union of every handler's return type", () => {
    expectTypeOf(matchTag(numOrTagged, handlers)).toEqualTypeOf<string | number | boolean>()
    expectTypeOf(pipe(numOrTagged, matchTag(handlers))).toEqualTypeOf<string | number | boolean>()
  })

  test("handler parameters narrow to the tagged member", () => {
    matchTag(numOrTagged, {
      ok: (n) => expectTypeOf(n).toEqualTypeOf<number>(),
      NotFound: (e) => expectTypeOf(e).toEqualTypeOf<NotFound>(),
      Forbidden: (e) => expectTypeOf(e).toEqualTypeOf<Forbidden>()
    })
    pipe(
      numOrTagged,
      matchTag({
        ok: (n) => expectTypeOf(n).toEqualTypeOf<number>(),
        NotFound: (e) => expectTypeOf(e).toEqualTypeOf<NotFound>(),
        Forbidden: (e) => expectTypeOf(e).toEqualTypeOf<Forbidden>()
      })
    )
  })

  test("a missing handler is a type error", () => {
    // @ts-expect-error Forbidden handler missing
    matchTag(numOrTagged, { ok: (n: number) => n, NotFound: (e: NotFound) => e.id })
    // @ts-expect-error ok handler missing
    matchTag(numOrTagged, { NotFound: (e: NotFound) => e.id, Forbidden: (e: Forbidden) => e.reason })
    const partial = matchTag({ ok: (n: number) => n, NotFound: (e: NotFound) => e.id })
    // @ts-expect-error data-last: handlers cover NotFound only, so the Result's E may not include Forbidden
    partial(numOrTagged)
  })

  test("an ok-only Result needs only the ok handler", () => {
    expectTypeOf(matchTag(ok(1), { ok: (n) => String(n) })).toEqualTypeOf<string>()
  })
})

describe("E widens only through |", () => {
  test("chained andThen accumulates the error union", () => {
    const step1 = (n: number): Result<number, NotFound> => n ? ok(n) : err(NotFound({ resource: "a", id: "1" }))
    const step2 = (n: number): Result<string, Forbidden> => n ? ok("s") : err(Forbidden({ reason: "r" }))
    const step3 = (s: string): Result<boolean, "plain"> => s ? ok(true) : err("plain")
    const r = pipe(ok(1), andThen(step1), andThen(step2), andThen(step3))
    expectTypeOf(r).toEqualTypeOf<Result<boolean, NotFound | Forbidden | "plain">>()
    const r2 = andThen(andThen(andThen(ok(1), step1), step2), step3)
    expectTypeOf(r2).toEqualTypeOf<Result<boolean, NotFound | Forbidden | "plain">>()
  })

  test("map never touches E; mapErr replaces it", () => {
    expectTypeOf(pipe(numOrTagged, map(String))).toEqualTypeOf<Result<string, NotFound | Forbidden>>()
    expectTypeOf(pipe(numOrTagged, mapErr((e) => e._tag))).toEqualTypeOf<Result<number, "NotFound" | "Forbidden">>()
  })
})

describe("all / partition", () => {
  test("all is tuple-aware and unions the errors", () => {
    const a: Result<number, "a"> = err("a")
    const b: Result<string, "b"> = err("b")
    // The annotated assignments ARE the assertions: vitest --typecheck fails on any assignment
    // type error, and they dodge expect-type's union-branding quirk with Result unions.
    const tup: Result<[number, string], "a" | "b"> = all([a, b])
    expectTypeOf(tup).toEqualTypeOf<Result<[number, string], "a" | "b">>()
    const both: Result<[number, string], never> = all([ok(1), ok("s")])
    expectTypeOf(both).toEqualTypeOf<Result<[number, string], never>>()
    const list: Array<Result<number, string>> = []
    const arr: Result<Array<number>, string> = all(list)
    expectTypeOf(arr).toEqualTypeOf<Result<Array<number>, string>>()
  })

  test("partition", () => {
    const list: Array<Result<number, string>> = []
    expectTypeOf(partition(list)).toEqualTypeOf<[Array<number>, Array<string>]>()
  })
})

describe("pipe / flow arity inference", () => {
  const inc = (n: number): number => n + 1
  const str = (n: number): string => String(n)
  const len = (s: string): number => s.length

  test("pipe at 2 / 5 / 9", () => {
    expectTypeOf(pipe(1, str)).toEqualTypeOf<string>()
    expectTypeOf(pipe(1, inc, inc, str, len, str)).toEqualTypeOf<string>()
    expectTypeOf(pipe(1, inc, str, len, inc, str, len, inc, str, len)).toEqualTypeOf<number>()
    expectTypeOf(pipe(1)).toEqualTypeOf<number>()
  })

  test("flow at 2 / 5 / 9 keeps the first function's parameters", () => {
    expectTypeOf(flow((a: number, b: number) => a + b, str)).toEqualTypeOf<(a: number, b: number) => string>()
    expectTypeOf(flow(inc, inc, str, len, str)).toEqualTypeOf<(n: number) => string>()
    expectTypeOf(flow(inc, str, len, inc, str, len, inc, str, len)).toEqualTypeOf<(n: number) => number>()
    expectTypeOf(flow((s: string) => s.length)).toEqualTypeOf<(s: string) => number>()
  })

  test("a type mismatch mid-pipe is an error at that position", () => {
    // @ts-expect-error len expects a string but receives a number
    pipe(1, inc, len)
    // @ts-expect-error len expects a string but receives a number
    flow(inc, len)
  })
})
