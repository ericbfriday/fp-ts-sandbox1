# ADR 0005 — Core owns the fixed vocabulary; every prop on a fixed tag is optional

Status: Accepted · Date: 2026-11-18 · Issue: #66 (grill-with-docs session)

## Decision

RFC-0001 §2 called the fixed tags "convention-fixed", but no package owned them. By #66 the same tag had several shapes: `NotFound` was `{resource,id}` in core's docs, `{reason?}` in db and `{id}` in the example. `Forbidden` was `{required?}` in better-auth and `{action}` in the example. Because `is()` checks only `_tag`, one package's guard narrowed another package's error to props it didn't have.

Core now exports one factory per fixed tag, from its root. Schema keeps `ValidationFailure` (it is the only producer, and its `is()` also checks that `issues` is an array). A fixed tag guarantees only `_tag` and an optional `message`. Every other prop on a fixed tag is optional, whoever declares it, so narrowing through any guard stays sound for errors built in-process. A package that needs more data declares its own factory for the same tag with extra *optional* props, and those props must agree with core's types. `taggedError`'s types enforce both rules whenever the tag is a fixed tag. App tags and adapter tags may still require props, because each has exactly one producer.

| Tag | Optional props |
|---|---|
| `NotFound` | `resource`, `id` |
| `Conflict` | `field`, `constraint` |
| `Forbidden` | `required` |
| `Unauthenticated` | none |
| `Timeout` | `ms` |
| `NetworkError` | `reason` |
| `DbUnavailable` | none (db produces it from connection failures; `/wire` default 503) |
| `ValidationFailure` | `issues` is required (schema-owned) |

Default statuses in `/wire` gain `DbUnavailable` 503, `Timeout` 504 and `NetworkError` 502.

Infrastructure tags cross the wire as tag + status only (Eric, 2026-11-18, #87): `/wire`'s `sanitize` and `toProblem` drop `message` and every prop of `NetworkError`, `DbUnavailable` and `Timeout` unless the caller's `safeProps` names them (`message` too), because their text and props come from drivers and sockets (hosts, DSNs, `ECONNREFUSED 10.0.0.5:5432`), the same leak class as #30. Domain, app and adapter tags are unchanged.

## Considered options

- **Required props per tag** (for example `NotFound{resource}`). Rejected because db can't fill them: a missing row doesn't know its resource unless every caller passes it in.
- **Convention only, each package keeps its own factory.** Rejected: this was the state before #66, and it produced the drift above.
- **A separate vocabulary package.** Rejected: it adds a package that every other package must depend on, against IDEA §5 ("adapters import core (and schema)").
- **`is()` validates props at runtime.** Rejected as costly, and impossible for a generic `P` without a schema.

## Consequences

- Errors rebuilt from the wire (`fromWire`, `reconstruct`, `fromTRPC`) carry untrusted JSON. No guard makes their props sound, so read them as hints.
- Adding a prop to a fixed tag later is non-breaking, as long as it is optional. Making one required is a new ADR.
