/**
 * `@friday-friday/next/client` — boundary helpers for errors a CLIENT component throws
 * (Design Report §5.1 "Client"; #53).
 *
 * Scope: only a throw that happens in the browser keeps its tagged data. An error thrown on the
 * server (a Server Component, or `toThrowable` there) crosses React Flight, which sends the client
 * only `{ digest }` in production and `{ name, message, stack, env }` in development: never
 * `data` or any other prop (next 16.4.6's compiled react-server-dom-webpack, `emitErrorChunk`;
 * pinned by test/flight.test.ts). So `tagged` is always `undefined` for server-thrown errors:
 * server domain errors travel as returned Results (report §5.1), not thrown ones.
 *
 * `import "client-only"` makes importing this module under the `react-server` condition throw;
 * `client-only` is a runtime dependency so the import survives the build (dist smoke).
 *
 * Uses `createElement` (not JSX) so this stays a pure `.ts` module.
 */
import { type Result, type TaggedError, toThrowable } from "@friday-friday/core"
// oxlint-disable-next-line import/no-unassigned-import -- side-effect guard: throws under react-server
import "client-only"
import { catchError, type ErrorInfo } from "next/error"
import { type ComponentType, createElement, type ReactNode } from "react"

export interface BoundaryProps {
  /** What the boundary caught: any thrown value. */
  readonly error: unknown
  /**
   * The tagged error, when the client-side throw is one (thrown as-is) or wraps one (`orThrow` /
   * `toThrowable`'s `data`). Narrow it with a factory's `.is()`. Always `undefined` for errors
   * thrown on the server.
   */
  readonly tagged: TaggedError<string> | undefined
}

const isTagged = (u: unknown): u is TaggedError<string> =>
  typeof u === "object" && u !== null && "_tag" in u && typeof u._tag === "string"

/** The tagged error a client-side throw is or carries (`toThrowable`'s `data`), structurally checked. */
const decode = (error: unknown): TaggedError<string> | undefined => {
  if (isTagged(error)) return error
  if (typeof error === "object" && error !== null && "data" in error && isTagged(error.data)) return error.data
  return undefined
}

/**
 * Unwrap an `Ok`, or throw the `Err` as `toThrowable(e)` (no `cause`) for the nearest
 * {@link resultBoundary}. For client components: on the server the throw would reach the
 * browser as a digest only.
 */
export function orThrow<T>(r: Result<T, TaggedError<string>>): T {
  if (!r.ok) throw toThrowable(r.error)
  return r.value
}

/**
 * Wrap Next.js `catchError` (stable since 16.3; it rethrows Next's control-flow errors) so the
 * fallback gets the caught value and its decoded tagged error, if a client component threw one.
 */
export function resultBoundary(
  Fallback: (props: BoundaryProps) => ReactNode
): ComponentType<{ children?: ReactNode }> {
  return catchError((_props: {}, info: ErrorInfo) =>
    createElement(Fallback, { error: info.error, tagged: decode(info.error) })
  )
}
