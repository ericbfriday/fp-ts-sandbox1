# Glossary — `@friday-friday/*` functional-light suite

The terms this repo uses for errors-as-values at framework boundaries. Definitions follow `docs/spec/rfc-0001-core.md` (RFC) and `IDEA.md` §4; when they disagree with code, the RFC wins and the code gets a ticket.

## Results

**Result**:
The plain-object union `Ok<T> | Err<E>`, discriminated by `ok: boolean`, with no class or prototype so it survives any serializer unchanged (RFC §1).
_Avoid_: Either, Outcome, Try

**Ok / Err**:
The two Result members: `{ ok: true, value }` for success and `{ ok: false, error }` for an expected failure, built by `ok(v)` and `err(e)` (RFC §1).
_Avoid_: Success/Failure, Left/Right

**AsyncResult**:
`Promise<Result<T, E>>`: an expected failure resolves as `Err`; the promise rejects only with a defect or a sentinel (RFC §1, §3).
_Avoid_: ResultAsync, Task

**dual**:
A combinator callable data-first (`map(r, f)`) or data-last (`map(f)`, for `pipe`), dispatched on `arguments.length` (IDEA §4.5, RFC §4).
_Avoid_: curried, overloaded

**lane**:
One execution path a Result or a throw travels (core's sync, `/async` and `/gen` lanes; better-auth's server and client lanes), each triaging defects the same way.
_Avoid_: channel (reserved for tRPC's data and error channels)

## Errors

**tagged error**:
An expected failure as plain data: an object with a literal `_tag`, an optional `message` and JSON-safe props, checked structurally and never with `instanceof` (RFC §2).
_Avoid_: exception, error class, error instance

**error factory**:
The callable `ErrorFactory<Tag, P>` that `taggedError(tag)<P>()` returns: it builds tagged errors of one tag and carries `.tag` and the structural `.is()` guard (RFC §2).
_Avoid_: error constructor, error class

**fixed vocabulary**:
The tags every package agrees on, the domain tags plus the infrastructure tags, each owned by one package (core; schema for `ValidationFailure`). A fixed tag guarantees only `_tag` and an optional `message`; any other prop on it is optional, whoever declares it (#66).
_Avoid_: domain vocabulary (ambiguous with domain tag), error codes, error enum

**domain tag**:
A fixed tag for a failure that comes from business rules: `NotFound`, `Conflict`, `Forbidden`, `Unauthenticated`, `ValidationFailure`.
_Avoid_: business error, user error

**infrastructure tag**:
A fixed tag for a failure that comes from the transport or a dependency: `NetworkError`, `Timeout`, `DbUnavailable`.
_Avoid_: system error, technical error

**app tag**:
Any tag outside the fixed vocabulary that an app, not an adapter, defines for its own expected failures; its factory may require props because it is the only producer.
_Avoid_: custom error, user-defined error

**adapter tag**:
A tag outside the fixed vocabulary that exactly one adapter defines and produces, meaningful only inside that adapter (`HttpError`, `AuthApiError`, `ForeignKeyViolation`, `NotNullViolation`).
_Avoid_: library error, vendor error

**ValidationFailure**:
The tagged error for failed Standard Schema validation, `{ _tag: "ValidationFailure", issues: [{ message, path }] }`, produced by `@friday-friday/schema` and returned as data, never thrown.
_Avoid_: ZodError, validation exception

## Defects and triage

**defect**:
A failure nobody planned for (a bug, or a throw that triage did not map); it is thrown and never appears in `E` (IDEA §4.3, RFC §3).
_Avoid_: unexpected error, crash, fatal error

**Panic**:
The `Error` subclass a defect is thrown as, holding the original throw as `cause`; every lane produces it through the idempotent `toPanic(cause)` (RFC §3).
_Avoid_: fatal, bug error

**InternalDefect**:
The tagged error that stands in for a defect at the wire, carrying no `cause` or internals while the adapter reports the original server-side; core `/wire`'s `toDefect` builds it (RFC §2, §6).
_Avoid_: 500 error, server error

**triage**:
The boundary decision on an unknown throw: rethrow a sentinel first, map a known throw to a tagged error with `catch`, or treat it as a defect when `catch` returns `undefined` (RFC §3).
_Avoid_: error handling, catch-all

**sentinel**:
A value a framework throws for control flow, such as Next.js `redirect()`/`notFound()` or TanStack Router `notFound()`/`redirect()`; triage rethrows it untouched (IDEA §6).
_Avoid_: redirect error, control-flow exception

## Wire

**wire envelope**:
The JSON form a Result takes across a boundary, `{ ok, value }` or `{ ok: false, error: { _tag, ...props } }`, with `cause` and non-JSON-safe props removed (RFC §5).
_Avoid_: payload, DTO

**sanitize**:
To project a tagged error onto its wire-safe form: keep `_tag`, `message` and JSON-safe props, and drop `cause` and everything else; core `/wire`'s `sanitize` is the one implementation (RFC §5.3).
_Avoid_: serialize, strip, scrub

**problem body**:
An RFC 9457 `application/problem+json` object (`type`, `title`, `status`, `detail`) plus a `tag` member and the error's safe props, built by core `/wire`'s `toProblem` (RFC §6).
_Avoid_: error response, problem details JSON

**reconstruct**:
To rebuild a tagged error on the receiving side from a problem body's `tag` or a sanitized error, so client and server see the same `_tag` and props; core `/wire`'s `fromWire` does it (RFC §6).
_Avoid_: deserialize, rehydrate, revive

## Packages

**adapter**:
A package that absorbs one framework's boundary traps for the Result core; it imports `core` (and `schema`) plus its own peers, never another adapter (IDEA §5).
_Avoid_: integration, plugin, binding
