# 2026-11-19 — `@friday-friday/next/client` covers client-thrown errors only (#53, parent #51)

Design Report §5.1 lists `orThrow(r)` under "RSC loaders" and says `resultBoundary` "decodes the
tagged data attached by `toThrowable`". That only holds for an error thrown in the browser. This
note re-scopes both, as #51 ("Interfaces stop promising what the platform can't deliver") asks.
**No IDEA §4 decision changes**; it applies §4.2 / RFC-0001 §2 (`cause` stays server-side).

## Evidence (next 16.4.6, verified by running it: `packages/next/test/flight.test.ts`)

`next/dist/compiled/react-server-dom-webpack/cjs/`:

- `react-server-dom-webpack-server.node.production.js`, `emitErrorChunk(request, id, digest)`:
  the error row is `{ digest }` and nothing else.
- `react-server-dom-webpack-server.node.development.js`, `emitErrorChunk(...)` and
  `serializeErrorValue(...)`: the row is `{ digest, name, message, stack, env, owner }`, plus
  `cause` whenever `"cause" in error` (so a non-enumerable `cause` is sent too) and `errors` for an
  `AggregateError`. No other own property, so `toThrowable`'s `data` never crosses.

## Decisions

1. **`toThrowable` (core) never sets `cause` on the Error.** Non-enumerable would not help (the
   check is `in`). The tagged error, `cause` included, stays reachable server-side as `data`.
2. **`orThrow` moves from the root (react-server) to `/client`.** On the server its throw reaches
   error.tsx as a digest, which a plain `throw toThrowable(e)` does just as well; on the client it
   pairs with `resultBoundary`. Server domain errors cross as returned Results (report §5.1).
3. **`resultBoundary` reads the caught value from `catchError`'s `ErrorInfo`** (second argument;
   the old code read user props and never saw an error) and decodes a thrown tagged error or
   `toThrowable`'s `data`. `tagged` is `TaggedError<string> | undefined`, narrowed with a
   factory's `.is()`: any descendant can throw, so a caller-chosen `E` was an unchecked cast.
4. **`client-only` is a runtime dependency**, so tsdown keeps `import "client-only"` in
   `dist/client.js`; next's dist smoke asserts the import and that `/client` throws under
   `--conditions=react-server`.

U: a client component that throws during SSR (Fizz, not Flight) is assumed to re-render and
re-throw in the browser, where the boundary sees the in-memory Error with `data`. Not run here.
