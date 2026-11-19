/**
 * The defect-triage contract (IDEA §4.3, RFC-0001 §3, issue #31): one table, every lane.
 *
 * Each row runs one public export so that a supplied `cause` is thrown or rejected at one
 * point (a sync throw in a callback, an async rejection, or a rejecting input promise). The
 * same two properties must hold for every row:
 *
 * 1. a foreign throw comes out as `Panic` with the original as `cause`;
 * 2. an existing `Panic` comes out as the SAME instance (identity preserved, no double wrap).
 */
import {
  andThen,
  err,
  fromNullable,
  map,
  mapErr,
  match,
  matchTag,
  ok,
  orElse,
  Panic,
  type Result,
  tap,
  tapErr,
  toPanic,
  trySync
} from "@friday-friday/core"
import {
  allAsync,
  andThenAsync,
  mapAsync,
  mapConcurrent,
  orElseAsync,
  retry,
  tapAsync,
  tapErrAsync,
  timeout,
  tryAsync
} from "@friday-friday/core/async"
import { $, gen, genAsync } from "@friday-friday/core/gen"
import { describe, expect, it } from "vitest"
import { type Forbidden, NotFound, type NotFound as NotFoundT } from "./_fixtures.js"

type Kind = "sync throw" | "async rejection" | "rejecting input"

/** A row: run one export so that `cause` escapes at the point named by `kind`. */
interface Row {
  readonly lane: "sync" | "/async" | "/gen"
  readonly name: string
  readonly kind: Kind
  readonly run: (cause: unknown) => unknown
}

/** An async export must never throw synchronously: its defects arrive as a rejection. */
const isAsyncExport = (row: Row): boolean => row.lane === "/async" || row.name === "genAsync"

/**
 * What escaped the row: the sync throw (sync lanes) or the rejection (async exports, which must
 * return a promise rather than throw), or a loud failure if nothing did.
 */
const escaped = async (row: Row, cause: unknown): Promise<unknown> => {
  let returned: unknown
  try {
    returned = row.run(cause)
  } catch (x) {
    if (isAsyncExport(row)) throw new Error(`${row.name} threw synchronously instead of rejecting`, { cause: x })
    return x
  }
  try {
    await returned
  } catch (x) {
    return x
  }
  throw new Error("expected the export to throw or reject, but it returned")
}

const thrower = (cause: unknown) => (): never => {
  throw cause
}

const rejecter = (cause: unknown) => async (): Promise<never> => {
  throw cause
}

const r: Result<number, string> = ok(1)
const e: Result<number, string> = err("bad")
const tagged: Result<number, NotFoundT | Forbidden> = err(NotFound({ resource: "user", id: "1" }))
const okTagged: Result<number, NotFoundT | Forbidden> = ok(1)

/** Rows within one lane: the lane is filled in once per table. */
type LaneRow = Omit<Row, "lane">

const syncLane: ReadonlyArray<Row> = ([
  { name: "map", run: (c) => map(r, thrower(c)) },
  { name: "map (data-last)", run: (c) => map(thrower(c))(r) },
  { name: "mapErr", run: (c) => mapErr(e, thrower(c)) },
  { name: "andThen", run: (c) => andThen(r, thrower(c)) },
  { name: "orElse", run: (c) => orElse(e, thrower(c)) },
  { name: "tap", run: (c) => tap(r, thrower(c)) },
  { name: "tapErr", run: (c) => tapErr(e, thrower(c)) },
  { name: "match ok", run: (c) => match(r, { ok: thrower(c), err: () => 0 }) },
  { name: "match err", run: (c) => match(e, { ok: () => 0, err: thrower(c) }) },
  { name: "matchTag ok", run: (c) => matchTag(okTagged, { ok: thrower(c), NotFound: () => 0, Forbidden: () => 0 }) },
  { name: "matchTag tag", run: (c) => matchTag(tagged, { ok: () => 0, NotFound: thrower(c), Forbidden: () => 0 }) },
  { name: "fromNullable", run: (c) => fromNullable(null, thrower(c)) },
  { name: "trySync (unmapped)", run: (c) => trySync(thrower(c), { catch: () => undefined }) },
  { name: "trySync (throwing catch)", run: (c) => trySync(thrower("original"), { catch: thrower(c) }) }
] satisfies Array<Omit<LaneRow, "kind">>).map((row) => ({ ...row, lane: "sync", kind: "sync throw" }))

/** The five pure `/async` duals share one shape: a callback on the branch the input takes. */
const asyncDuals: ReadonlyArray<Row> = (
  [
    ["mapAsync", (f: () => Promise<never>) => mapAsync(Promise.resolve(r), f), mapAsync(() => 0)],
    ["andThenAsync", (f: () => Promise<never>) => andThenAsync(Promise.resolve(r), f), andThenAsync(() => r)],
    ["orElseAsync", (f: () => Promise<never>) => orElseAsync(Promise.resolve(e), f), orElseAsync(() => r)],
    ["tapAsync", (f: () => Promise<never>) => tapAsync(Promise.resolve(r), f), tapAsync(() => {})],
    ["tapErrAsync", (f: () => Promise<never>) => tapErrAsync(Promise.resolve(e), f), tapErrAsync(() => {})]
  ] as const
).flatMap(([name, withCallback, dataLast]): Array<Row> => [
  { lane: "/async", name, kind: "sync throw", run: (c) => withCallback(thrower(c)) },
  { lane: "/async", name, kind: "async rejection", run: (c) => withCallback(rejecter(c)) },
  { lane: "/async", name, kind: "rejecting input", run: (c) => dataLast(Promise.reject(c)) }
])

const asyncHelpers: ReadonlyArray<Row> = ([
  { name: "allAsync", kind: "sync throw", run: (c) => allAsync([thrower(c)]) },
  { name: "allAsync", kind: "async rejection", run: (c) => allAsync([async () => ok(1), rejecter(c)]) },
  { name: "mapConcurrent", kind: "sync throw", run: (c) => mapConcurrent([1], thrower(c), { limit: 1 }) },
  { name: "mapConcurrent", kind: "async rejection", run: (c) => mapConcurrent([1, 2], rejecter(c), { limit: 2 }) },
  { name: "retry", kind: "sync throw", run: (c) => retry(thrower(c), { times: 2 }) },
  { name: "retry", kind: "async rejection", run: (c) => retry(rejecter(c), { times: 2 }) },
  {
    name: "retry (while predicate)",
    kind: "sync throw",
    run: (c) => retry(async () => err("again"), { times: 2, while: thrower(c) })
  },
  { name: "timeout", kind: "sync throw", run: (c) => timeout(thrower(c), 1000) },
  { name: "timeout", kind: "async rejection", run: (c) => timeout(rejecter(c), 1000) },
  { name: "tryAsync (unmapped)", kind: "sync throw", run: (c) => tryAsync(thrower(c), { catch: () => undefined }) },
  {
    name: "tryAsync (unmapped)",
    kind: "async rejection",
    run: (c) => tryAsync(rejecter(c), { catch: () => undefined })
  },
  {
    name: "tryAsync (throwing catch)",
    kind: "sync throw",
    run: (c) => tryAsync(rejecter("original"), { catch: thrower(c) })
  }
] satisfies Array<LaneRow>).map((row) => ({ ...row, lane: "/async" }))

const genLane: ReadonlyArray<Row> = ([
  {
    name: "gen",
    kind: "sync throw",
    run: (c) =>
      gen(function*() {
        const a = yield* $(r)
        return a + thrower(c)()
      })
  },
  {
    name: "genAsync",
    kind: "sync throw",
    run: (c) =>
      genAsync(async function*() {
        const a = yield* $(r)
        return a + thrower(c)()
      })
  },
  {
    name: "genAsync",
    kind: "async rejection",
    run: (c) =>
      genAsync(async function*() {
        const a = yield* $(r)
        return a + (await rejecter(c)())
      })
  }
] satisfies Array<LaneRow>).map((row) => ({ ...row, lane: "/gen" }))

const rows: ReadonlyArray<Row> = [...syncLane, ...asyncDuals, ...asyncHelpers, ...genLane]

describe("defect-triage contract: every lane, one table", () => {
  const label = "%s %s (%s)"
  const table = rows.map((row) => [row.lane, row.name, row.kind, row] as const)

  it.each(table)(`${label}: a foreign throw becomes Panic with the original as cause`, async (...args) => {
    const row = args[3]
    const boom = new Error("boom")
    const x = await escaped(row, boom)
    expect(x).toBeInstanceOf(Panic)
    expect(x).toMatchObject({ name: "Panic", message: "boom", cause: boom })
  })

  it.each(table)(`${label}: an existing Panic passes through with identity preserved`, async (...args) => {
    const row = args[3]
    const existing = new Panic("already a defect")
    expect(await escaped(row, existing)).toBe(existing)
  })
})

describe("toPanic (the one Panic conversion, exported for adapters and bridges)", () => {
  it("wraps a foreign cause, keeping it as cause", () => {
    const boom = new Error("boom")
    const p = toPanic(boom)
    expect(p).toBeInstanceOf(Panic)
    expect(p.cause).toBe(boom)
    expect(p.message).toBe("boom")
  })

  it("is idempotent: an existing Panic is returned as the same instance", () => {
    const p = new Panic("x")
    expect(toPanic(p)).toBe(p)
    expect(toPanic(toPanic("y"))).toStrictEqual(toPanic("y"))
  })

  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    return proxy
  }

  it.each<[string, () => unknown, string]>([
    ["a revoked Proxy", revoked, "Unprintable thrown value"],
    [
      "an object whose _tag getter throws",
      () => ({
        get _tag(): string {
          throw new Error("getter")
        }
      }),
      "Unprintable thrown value"
    ],
    [
      "an Error whose message getter throws",
      () =>
        Object.defineProperty(new Error("x"), "message", {
          get(): string {
            throw new Error("message getter")
          }
        }),
      "Unprintable thrown value"
    ],
    ["a null-prototype object", () => Object.create(null), "Non-Error thrown"]
  ])("is total: %s becomes a Panic (never throws), the value kept as cause", (_name, make, message) => {
    const cause = make()
    const p = toPanic(cause)
    expect(p).toBeInstanceOf(Panic)
    expect(p.message).toBe(message)
    expect(p.cause).toBe(cause)
  })
})
