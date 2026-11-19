/**
 * `@friday-friday/db` runtime tests, through the package's public interface. Inputs are
 * the real error shapes thrown by pg, postgres-js, drizzle-orm and Prisma 6/7, captured
 * against a live PostgreSQL and rebuilt vendor-free in `_fixtures.ts`.
 */
import { Conflict, DbUnavailable, NotFound } from "@friday-friday/core"
import { toProblem } from "@friday-friday/core/wire"
import * as db from "@friday-friday/db"
import { ForeignKeyViolation, mapDbError, mapPgError, mapPrismaError, NotNullViolation } from "@friday-friday/db"
import net from "node:net"
import { describe, expect, it } from "vitest"
import {
  dnsNotFound,
  drizzleWrapped,
  pgAdminShutdown,
  pgCannotConnectNow,
  pgConnectionException,
  pgCrashShutdown,
  pgForeignKey,
  pgNotNull,
  pgProtocolViolation,
  pgTerminatedUnexpectedly,
  pgTimeoutExpired,
  pgUndefinedTable,
  pgUnique,
  postgresJsAdminShutdown,
  postgresJsCannotConnectNow,
  postgresJsConnectionClosed,
  postgresJsConnectTimeout,
  postgresJsForeignKey,
  postgresJsNotNull,
  postgresJsRefused,
  postgresJsUnique,
  prisma6ForeignKey,
  prisma6ModelAdminShutdown,
  prisma6NotFound,
  prisma6RawAdminShutdown,
  prisma6ReachedButTimedOut,
  prisma6Unique,
  prisma6UnreachableOnConnect,
  prisma6UnreachableOnQuery,
  prisma7ConnectionClosed,
  prisma7ForeignKey,
  prisma7ModelAdminShutdown,
  prisma7NotFound,
  prisma7RawAdminShutdown,
  prisma7RawUndefinedTable,
  prisma7TimedOut,
  prisma7Unique,
  prisma7UniqueByFields,
  prisma7Unreachable,
  socketRefused,
  socketReset,
  socketTimedOut
} from "./_fixtures.js"

/**
 * What survives a boundary: every sanitizer drops `cause` (RFC-0001 §5.3) and keeps the
 * JSON-safe props, so this is the strictest view a client can get of a mapped error.
 */
const wireJson = (e: object | null): string => JSON.stringify({ ...e, cause: undefined })

describe("driver detail and row values stay server-side", () => {
  // Every real-shaped input that maps, including ORM wrappers whose message embeds params.
  const inputs: ReadonlyArray<readonly [string, () => Error]> = [
    ["pg 23505", pgUnique],
    ["pg 23503", pgForeignKey],
    ["pg 23502", pgNotNull],
    ["postgres-js 23505", postgresJsUnique],
    ["postgres-js 23503", postgresJsForeignKey],
    ["postgres-js 23502", postgresJsNotNull],
    ["drizzle(pg 23505)", () => drizzleWrapped(pgUnique(), "insert into users values ($1, $2)", [2, "a@example.com"])],
    ["drizzle(pg 23503)", () => drizzleWrapped(pgForeignKey(), "insert into posts values ($1, $2, $3)", [1, 42, "t"])],
    ["prisma 6 P2002", prisma6Unique],
    ["prisma 6 P2003", prisma6ForeignKey],
    ["prisma 6 P2025", prisma6NotFound],
    ["prisma 7 P2002", prisma7Unique],
    ["prisma 7 P2003", prisma7ForeignKey],
    ["prisma 7 P2025", prisma7NotFound],
    ["ECONNREFUSED", socketRefused],
    ["postgres-js ECONNREFUSED", postgresJsRefused],
    ["pg 57P01", pgAdminShutdown],
    ["prisma 7 P1001", prisma7Unreachable],
    ["prisma 6 P1001", prisma6UnreachableOnConnect],
    ["postgres-js CONNECTION_CLOSED", postgresJsConnectionClosed],
    ["prisma 6 lazy connect", prisma6UnreachableOnQuery],
    ["prisma 6 P2010(57P01)", prisma6RawAdminShutdown],
    ["prisma 7 P2039(57P01)", prisma7ModelAdminShutdown]
  ]

  it.each(inputs)("%s: no detail/message/query text outside cause; original reachable on cause", (_, make) => {
    const e = make()
    const mapped = mapDbError(e)
    expect(mapped).not.toBe(null)
    expect(mapped).toHaveProperty("cause", e)
    const wire = wireJson(mapped)
    const leaks = ["a@example.com", "(42)", "Failing row", "Key (", "insert into", "select ", "Invalid `prisma"]
    for (
      const leak of [...leaks, "10.0.0.5", "5432", "ECONNREFUSED", "CONNECTION_CLOSED", "terminating", "Can't reach"]
    ) {
      expect(wire).not.toContain(leak)
    }
    expect(mapped).not.toHaveProperty("detail")
    expect(mapped).not.toHaveProperty("message")
  })

  it.each(inputs)("%s: the cause-stripped error round-trips JSON and structuredClone (RFC-0001 §5.2)", (_, make) => {
    // `cause` is runtime-only (RFC-0001 §2), so strip it the way a sanitizer does.
    const wire = Object.fromEntries(Object.entries(mapDbError(make()) ?? {}).filter(([k]) => k !== "cause"))
    expect(Object.keys(wire)).toContain("_tag")
    expect(JSON.parse(JSON.stringify(wire))).toStrictEqual(wire)
    expect(structuredClone(wire)).toStrictEqual(wire)
  })
})

describe("mapPgError (SQLSTATE)", () => {
  it("pg 23505 -> Conflict carrying the constraint name, driver error kept on cause", () => {
    const e = pgUnique()
    expect(mapPgError(e)).toEqual(Conflict({ constraint: "users_email_key", cause: e }))
  })

  it("postgres-js 23505 -> Conflict reading snake_case constraint_name", () => {
    const e = postgresJsUnique()
    expect(mapPgError(e)).toEqual(Conflict({ constraint: "users_email_key", cause: e }))
  })

  it("pg 23503 -> ForeignKeyViolation with the constraint; detail (row values) stays on cause", () => {
    const e = pgForeignKey()
    const mapped = mapPgError(e)
    expect(mapped).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: e }))
    expect(mapped).not.toHaveProperty("detail")
  })

  it("23502 -> NotNullViolation with the column (pg column / postgres-js column_name); failing row stays on cause", () => {
    const pg = pgNotNull()
    expect(mapPgError(pg)).toEqual(NotNullViolation({ column: "title", cause: pg }))
    const pgJs = postgresJsNotNull()
    expect(mapPgError(pgJs)).toEqual(NotNullViolation({ column: "title", cause: pgJs }))
  })

  it("other codes / non-errors -> null (caller rethrows as defect)", () => {
    expect(mapPgError(pgUndefinedTable())).toBe(null)
    expect(mapPgError(new Error("boom"))).toBe(null)
    expect(mapPgError(null)).toBe(null)
    expect(mapPgError(undefined)).toBe(null)
  })
})

describe("cause chain (drizzle-orm wraps the driver error in DrizzleQueryError)", () => {
  it("finds the SQLSTATE on cause for node-postgres and postgres-js sessions", () => {
    const viaPg = drizzleWrapped(pgUnique(), "insert into users values ($1, $2)", [2, "a@example.com"])
    expect(mapPgError(viaPg)).toEqual(Conflict({ constraint: "users_email_key", cause: viaPg }))
    const viaPgJs = drizzleWrapped(postgresJsForeignKey(), "insert into posts values ($1, $2, $3)", [1, 42, "t"])
    expect(mapPgError(viaPgJs)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: viaPgJs }))
  })

  it("is depth-limited: a driver code 5 wraps down maps, 6 wraps down does not", () => {
    const wrap = (inner: unknown, times: number): unknown =>
      times === 0 ? inner : wrap(new Error("wrapped", { cause: inner }), times - 1)
    const five = wrap(pgUnique(), 5)
    expect(mapPgError(five)).toEqual(Conflict({ constraint: "users_email_key", cause: five }))
    expect(mapPgError(wrap(pgUnique(), 6))).toBe(null)
  })

  it("is cycle-safe: a self-referencing cause chain returns null instead of looping", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    Object.assign(a, { cause: b })
    expect(mapPgError(a)).toBe(null)
    expect(mapPrismaError(a)).toBe(null)
  })
})

describe("mapPrismaError (P-codes)", () => {
  it("Prisma 6 P2002 -> Conflict with the field from meta.target", () => {
    const e = prisma6Unique()
    expect(mapPrismaError(e)).toEqual(Conflict({ field: "email", cause: e }))
  })

  it("Prisma 7 (driver adapter) P2002 -> Conflict from meta.driverAdapterError.cause.constraint", () => {
    const byIndex = prisma7Unique()
    expect(mapPrismaError(byIndex)).toEqual(Conflict({ constraint: "users_email_key", cause: byIndex }))
    const byFields = prisma7UniqueByFields()
    expect(mapPrismaError(byFields)).toEqual(Conflict({ field: "email", cause: byFields }))
  })

  it("P2003 (Prisma 6 meta.constraint / Prisma 7 adapter index) -> ForeignKeyViolation", () => {
    const v6 = prisma6ForeignKey()
    expect(mapPrismaError(v6)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: v6 }))
    const v7 = prisma7ForeignKey()
    expect(mapPrismaError(v7)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: v7 }))
  })

  it("P2025 -> core's NotFound (Prisma 6 and 7), original kept on cause", () => {
    for (const e of [prisma6NotFound(), prisma7NotFound()]) {
      expect(mapPrismaError(e)).toEqual(NotFound({ cause: e }))
    }
  })

  it("unknown P-codes and SQLSTATEs -> null", () => {
    expect(mapPrismaError({ code: "P9999" })).toBe(null)
    expect(mapPrismaError(pgUnique())).toBe(null)
  })
})

describe("mapDbError (both vocabularies)", () => {
  it("tries Prisma then PG, through wrappers too", () => {
    const prisma = prisma6Unique()
    expect(mapDbError(prisma)).toEqual(Conflict({ field: "email", cause: prisma }))
    const fk = pgForeignKey()
    expect(mapDbError(fk)).toEqual(ForeignKeyViolation({ constraint: "posts_user_id_fkey", cause: fk }))
    const wrapped = drizzleWrapped(pgNotNull(), "insert into posts (id, user_id) values ($1, $2)", [2, 1])
    expect(mapDbError(wrapped)).toEqual(NotNullViolation({ column: "title", cause: wrapped }))
    expect(mapDbError(pgUndefinedTable())).toBe(null)
  })
})

describe("connection failures -> core's DbUnavailable (#88, ADR-0005)", () => {
  const pg: ReadonlyArray<readonly [string, () => Error]> = [
    ["ECONNREFUSED (pg / node net)", socketRefused],
    ["ENOTFOUND (pg / node dns)", dnsNotFound],
    ["ETIMEDOUT (pg / node net)", socketTimedOut],
    ["ECONNRESET (pg / node net)", socketReset],
    ["postgres-js ECONNREFUSED", postgresJsRefused],
    ["postgres-js CONNECT_TIMEOUT", postgresJsConnectTimeout],
    ["postgres-js CONNECTION_CLOSED", postgresJsConnectionClosed],
    ["drizzle(postgres-js CONNECTION_CLOSED)", () => drizzleWrapped(postgresJsConnectionClosed(), "select 1", [])],
    ["drizzle(ECONNREFUSED)", () => drizzleWrapped(socketRefused(), "select 1", [])],
    ["pg 57P01 admin_shutdown", pgAdminShutdown],
    ["postgres-js 57P01 admin_shutdown", postgresJsAdminShutdown],
    ["drizzle(pg 57P01)", () => drizzleWrapped(pgAdminShutdown(), "select pg_sleep(5)", [])],
    ["pg 57P02 crash_shutdown (U)", pgCrashShutdown],
    ["pg 57P03 cannot_connect_now", pgCannotConnectNow],
    ["postgres-js 57P03 cannot_connect_now", postgresJsCannotConnectNow],
    ...["08000", "08003", "08006", "08001", "08004", "08007"].map(
      (code) => [`SQLSTATE ${code} (U)`, () => pgConnectionException(code)] as const
    )
  ]

  it.each(pg)("mapPgError: %s -> DbUnavailable, original on cause", (_, make) => {
    const e = make()
    expect(mapPgError(e)).toEqual(DbUnavailable({ cause: e }))
    expect(mapDbError(e)).toEqual(DbUnavailable({ cause: e }))
  })

  const prisma: ReadonlyArray<readonly [string, () => Error]> = [
    ["Prisma 7 P1001 (adapter-pg, KnownRequestError.code)", prisma7Unreachable],
    ["Prisma 6 P1001 ($connect, InitializationError.errorCode)", prisma6UnreachableOnConnect],
    ["Prisma 6 P1002 (U)", prisma6ReachedButTimedOut],
    ["Prisma 6 lazy connect (errorCode undefined, InitializationError's own text)", prisma6UnreachableOnQuery],
    ["Prisma 7 P1008 (adapter-pg ETIMEDOUT)", prisma7TimedOut],
    ["Prisma 7 P1017 (adapter-pg ECONNRESET)", prisma7ConnectionClosed],
    ["Prisma 6 P2010 wrapping 57P01 (meta.code)", prisma6RawAdminShutdown],
    ["Prisma 7 P2010 wrapping 57P01 (meta.driverAdapterError.cause.code)", prisma7RawAdminShutdown],
    ["Prisma 7 P2039 wrapping 57P01 (model query)", prisma7ModelAdminShutdown]
  ]

  it.each(prisma)("mapPrismaError: %s -> DbUnavailable, original on cause", (_, make) => {
    const e = make()
    expect(mapPrismaError(e)).toEqual(DbUnavailable({ cause: e }))
    expect(mapDbError(e)).toEqual(DbUnavailable({ cause: e }))
  })

  it("finds a socket code down the same <= 5-hop cause chain, not 6", () => {
    const wrap = (inner: unknown, times: number): unknown =>
      times === 0 ? inner : wrap(new Error("wrapped", { cause: inner }), times - 1)
    const five = wrap(socketRefused(), 5)
    expect(mapPgError(five)).toEqual(DbUnavailable({ cause: five }))
    expect(mapPgError(wrap(socketRefused(), 6))).toBe(null)
  })

  it("maps the real error Node's net throws, single address and AggregateError (multi-address)", async () => {
    // A port that was just listening and is now closed refuses deterministically on loopback.
    const closed = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, "127.0.0.1", () => {
        const address = server.address()
        const port = typeof address === "object" && address !== null ? address.port : 0
        server.close(() => resolve(port))
      })
    })
    const connectError = (options: net.NetConnectOpts): Promise<unknown> =>
      new Promise((resolve) => net.connect(options).on("error", resolve))
    const single = await connectError({ host: "127.0.0.1", port: closed })
    expect(single).toMatchObject({ code: "ECONNREFUSED", syscall: "connect", port: closed })
    expect(mapPgError(single)).toEqual(DbUnavailable({ cause: single }))
    // Happy eyeballs: two addresses, both fail; Node puts `code` on the AggregateError itself.
    const multi = await connectError({
      host: "db.example",
      port: closed,
      autoSelectFamily: true,
      lookup: (_host, _options, callback) => {
        const all = [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }] // oxlint-disable-next-line no-unsafe-type-assertion -- net's LookupFunction overloads; all: true is set by autoSelectFamily
        ;(callback as unknown as (e: null, a: typeof all) => void)(null, all)
      }
    })
    expect(multi).toBeInstanceOf(AggregateError)
    expect(mapPgError(multi)).toEqual(DbUnavailable({ cause: multi }))
  })

  it("leaves non-connection look-alikes unmapped (null -> the caller's defect lane)", () => {
    // 08P01 is class 08 but, as captured, a client bug (wrong Bind parameter count): retrying won't help.
    expect(mapPgError(pgProtocolViolation())).toBe(null)
    // P2010 / P2039 map only when the wrapped SQLSTATE is a connection failure (#99).
    expect(mapDbError(prisma7RawUndefinedTable())).toBe(null)
    expect(mapPrismaError({ code: "P2010", meta: { code: "08P01" } })).toBe(null)
    // Socket codes that aren't connection failures to a database.
    expect(mapPgError(Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }))).toBe(null)
    // P-codes are read from `errorCode` only by mapPrismaError; SQLSTATEs never from `errorCode`.
    expect(mapPgError({ errorCode: "57P01" })).toBe(null)
  })

  it("deliberate non-mappings (#99): shapes with nothing but message text outside a named class", () => {
    // pg throws these as bare `Error`s (no class, no own props): an app's `new Error(...)` with the
    // same text is the same object, so reading the message would map app errors too.
    for (const e of [pgTerminatedUnexpectedly(), pgTimeoutExpired()]) {
      expect(mapDbError(e)).toBe(null)
      expect(mapDbError(drizzleWrapped(e, "select 1", []))).toBe(null)
    }
    // Prisma 6 model query hit by 57P01: no code; the SQLSTATE is only inside Rust debug text.
    expect(mapDbError(prisma6ModelAdminShutdown())).toBe(null)
  })

  it("message text is read only on Prisma's PrismaClientInitializationError (#99)", () => {
    const text = prisma6UnreachableOnQuery().message
    expect(mapPrismaError(new Error(text))).toBe(null)
    expect(mapPrismaError(Object.assign(new Error(text), { name: "PrismaClientKnownRequestError" }))).toBe(null)
    expect(mapPrismaError(new Error("wrapped", { cause: new Error(text) }))).toBe(null)
    // A Prisma 6 InitializationError that is not "can't reach" (e.g. bad credentials) stays unmapped.
    const authFailed = Object.assign(new Error("Authentication failed against database server"), {
      name: "PrismaClientInitializationError"
    })
    expect(mapPrismaError(authFailed)).toBe(null)
  })

  it("through core /wire toProblem: a 503 problem body, tag only, no driver text or host (#87)", () => {
    const inputs = [
      socketRefused(),
      dnsNotFound(),
      pgAdminShutdown(),
      prisma7Unreachable(),
      prisma6UnreachableOnQuery()
    ]
    for (const e of [...inputs, postgresJsConnectionClosed(), prisma7ModelAdminShutdown()]) {
      const mapped = mapDbError(e)
      if (mapped === null) throw new Error("expected a mapped error")
      const body = toProblem(mapped)
      expect(body).toMatchObject({ status: 503, tag: "DbUnavailable", title: "Db Unavailable" })
      expect(Object.keys(body).sort()).toEqual(["status", "tag", "title", "type"])
      for (const leak of ["10.0.0.5", "5432", "db.internal", "ECONN", "ENOTFOUND", "terminating", "Can't reach"]) {
        expect(JSON.stringify(body)).not.toContain(leak)
      }
    }
  })
})

describe("fixed vocabulary: db produces core's factories (ADR-0005)", () => {
  it("exports no NotFound / Conflict / DbUnavailable factory of its own", () => {
    expect(Object.keys(db)).not.toContain("NotFound")
    expect(Object.keys(db)).not.toContain("Conflict")
    expect(Object.keys(db)).not.toContain("DbUnavailable")
  })

  it("core's NotFound.is / Conflict.is narrow db's errors, and every narrowed prop matches the value", () => {
    const notFound = mapDbError(prisma6NotFound())
    expect(NotFound.is(notFound)).toBe(true)
    if (NotFound.is(notFound)) {
      // core's NotFound: resource?/id?, both genuinely absent; no stray db-only prop either.
      expect(notFound.resource).toBe(undefined)
      expect(notFound.id).toBe(undefined)
      expect(Object.keys(notFound).sort()).toEqual(["_tag", "cause"])
    }
    const conflict = mapDbError(pgUnique())
    expect(Conflict.is(conflict)).toBe(true)
    if (Conflict.is(conflict)) expect(conflict.constraint).toBe("users_email_key")
  })
})
