import { err, type ErrorFactory, NotFound, ok, type Result, taggedError, Timeout } from "@friday-friday/core"
import * as fc from "fast-check"

// Fixed tags are core's (ADR-0005): `NotFound` and `Timeout` are core root's factories (value +
// type twins), so every prop on them is optional.
export { NotFound, Timeout }

// RFC-0001 §2 usage pattern for an extension of a fixed tag: explicit ErrorFactory annotation +
// ReturnType twin type; the extra prop is optional, as ADR-0005 requires (#92).
export const Forbidden: ErrorFactory<"Forbidden", { readonly reason?: string }> = taggedError("Forbidden")<
  { readonly reason?: string }
>()
export type Forbidden = ReturnType<typeof Forbidden>

// JSON round-trips normalize -0 to +0, so the arbitrary must not produce -0
// (toStrictEqual distinguishes them; JSON.stringify(-0) === "0").
const jsonInt: fc.Arbitrary<number> = fc.integer().map((n) => (Object.is(n, -0) ? 0 : n))

/** JSON-safe values: survive JSON.parse(JSON.stringify(x)) and structuredClone unchanged. */
export const jsonValue: fc.Arbitrary<unknown> = fc.oneof(
  jsonInt,
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.array(jsonInt, { maxLength: 4 }),
  // noNullPrototype: fast-check v4 records are null-prototype objects by default, which JSON
  // round-trips legitimately turn into normal-prototype objects (toStrictEqual checks that).
  fc.record({ a: fc.string(), b: jsonInt }, { noNullPrototype: true })
)

export const arbResult: fc.Arbitrary<Result<number, string>> = fc.oneof(
  jsonInt.map((n) => ok(n)),
  fc.string().map((s) => err(s))
)

export const arbJsonResult: fc.Arbitrary<Result<unknown, unknown>> = fc.oneof(
  jsonValue.map((v) => ok(v)),
  jsonValue.map((v) => err(v))
)

export const arbNotFound: fc.Arbitrary<NotFound> = fc
  .record({ resource: fc.string(), id: fc.string() })
  .map((p) => NotFound(p))

export const arbTagged: fc.Arbitrary<NotFound | Forbidden | Timeout> = fc.oneof(
  arbNotFound,
  fc.record({ reason: fc.string() }).map((p) => Forbidden(p)),
  fc.constant(Timeout({}))
)

export const arbTaggedResult: fc.Arbitrary<Result<unknown, NotFound | Forbidden | Timeout>> = fc.oneof(
  jsonValue.map((x) => ok<unknown>(x)),
  arbTagged.map((t) => err<NotFound | Forbidden | Timeout>(t))
)
