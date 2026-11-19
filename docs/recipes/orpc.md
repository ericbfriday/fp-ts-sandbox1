# Recipe: pairing `@friday-friday/*` with oRPC v2

oRPC (report §5.3 comparison) is genuinely better than tRPC for error typing: its
per-procedure `.errors()` declaration means the CLIENT can infer the error union instead of
declaring it. This recipe shows how the suite composes with oRPC without a dedicated
adapter package (yet). If you use oRPC heavily and want first-class support, say so — the
recipe below is the tested-in-practice shape.

## Server: procedures return Results as data, defects throw

oRPC v2 procedures accept middleware and handlers like tRPC. The suite's vocabulary maps
directly:

```ts
import { ORPC, meta } from "@orpc/server"
import { err, NotFound, ok, Panic } from "@friday-friday/core"
import { resultHandler } from "@friday-friday/tanstack-start" // vendor-light: pure wrapper
import { PostSchema } from "./schemas"

// `NotFound` is a fixed tag: use core's factory (`{ resource?, id? }`, ADR-0005). A local
// `taggedError("NotFound")<{ id: string }>()` is a compile error, because a fixed tag's props
// must all be optional (#92).

// Data channel by default: the Result IS the output, so .errors() stays free for
// oRPC's own machinery (or omit it and treat Err as data end-to-end).
export const getUser = ORPC.handler(async ({ input }) => {
  const r = await posts.find(input.id)
  if (!r.ok && r.error._tag === "NotFound") {
    // Option A (typed errors): declare via .errors() and throw an ORPCError-like shape
    throw new Error("not found") // see "typed errors" below
  }
  return r
})
```

Because oRPC declares errors PER PROCEDURE (`.errors({ NOT_FOUND: ... })`), you do NOT need
`fromTRPC`-style declared type parameters — the report's tRPC design limit does not apply.

## Wire format: reuse `problem()`/`reconstruct()` instead of a new vocabulary

oRPC talks JSON over POST like tRPC. Two options:

1. **Data channel (recommended):** handlers return the Result verbatim. Tagged errors are
   plain data and survive oRPC's JSON serialization unchanged — `err(NotFound({ id }))`
   arrives as `{ ok: false, error: { _tag: "NotFound", id } }`. No formatter needed.
2. **Error channel:** throw `new ORPCError("NOT_FOUND", { data: sanitize(e) })` with
   `@friday-friday/trpc`'s `sanitize()` (it is vendor-neutral), and reconstruct on the
   client with `@friday-friday/http`'s `reconstruct()`. Only reach for this when you need
   oRPC middleware (retry, interceptors) to observe failures.

## Validation: `resultHandler` works unchanged

oRPC input validation accepts Standard Schema directly, but the #6428-style structural-loss
problem does not exist there; still, `resultHandler(schema, handler)` is the simplest way to
get `ValidationFailure` issues as data and Panic-normalized defects:

```ts
export const createPost = ORPC.handler((input) => resultHandler(PostSchema, (v) => posts.create(v))({ data: input }))
```

## Client: plain `await` + Result checks

```ts
const r = await orpc.getUser.call({ id: "u_1" })
if (!r.ok && r.error._tag === "NotFound") renderNotFound(r.error.id)
```

## What a first-class `@friday-friday/orpc` would add

- `orpcErrors(map)` generating `.errors()` declarations from a `StatusMap`-like tag map
- A `respond()`-style output mapper reusing `problem()` for REST-adjacent oRPC routes
- Wire-contract tests against the real oRPC v2 client (same standard as PRs #22/#23)

Until someone asks for that, the data-channel recipe above needs no adapter code at all —
plain data means plain JSON means it just works.
