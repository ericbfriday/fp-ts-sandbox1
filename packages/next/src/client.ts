/**
 * `@friday-friday/next/client` — client-only boundary helpers (Design Report §5.1 "Client").
 *
 * `resultBoundary` wraps Next.js `catchError` (stable since 16.3): when a server component
 * throws a tagged error (via `orThrow`/`toThrowable`), production redacts the message to a
 * digest — but the TAGGED DATA travels with the thrown Error (`error.data`), so the boundary
 * can render structured, typed fallbacks without any server round-trip.
 *
 * Uses `createElement` (not JSX) so this stays a pure `.ts` module — the client surface has
 * zero markup of its own.
 */
import type { TaggedError } from "@friday-friday/core"
// oxlint-disable-next-line import/no-unassigned-import -- side-effect guard: throws under SSR
import "client-only"
import { catchError } from "next/error"
import { type ComponentType, createElement, type ReactNode } from "react"

export interface BoundaryProps<E extends TaggedError<string>> {
  /** The raw thrown Error (production redacts `message` to a `digest`). */
  readonly error: unknown
  /** The decoded tagged error from `toThrowable`'s `data` attachment, if present. */
  readonly tagged: E | undefined
}

type CatchErrorProps = { readonly error?: unknown }

/**
 * Decode the tagged error that `toThrowable` attached as `data`, defensively: the attached
 * `data` is untrusted wire data, structurally checked (`_tag` present) before the deliberate
 * narrowing assertion (same idiom as `All`; see ADR-0003).
 */
const extractTagged = (error: unknown): TaggedError<string> | undefined => {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined
  const data: unknown = error.data
  if (typeof data !== "object" || data === null || !("_tag" in data)) return undefined
  // The structural `_tag` check guards the deliberate narrowing assertion below: the attached
  // `data` is untrusted wire data, validated before the cast (same idiom as `All`; see ADR-0003).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above
  return data as TaggedError<string>
}

/**
 * Wrap Next.js `catchError` so the tagged error attached by `toThrowable` (via server-side
 * `orThrow`) is decoded into `props.tagged` before rendering the fallback. Callers narrow the
 * base tagged error to their concrete `E` inside their own fallback implementation.
 */
export function resultBoundary<E extends TaggedError<string>>(
  Fallback: (props: BoundaryProps<E>) => ReactNode
): ComponentType<{ children?: ReactNode }> {
  return catchError<CatchErrorProps>((props) => {
    const tagged = extractTagged(props.error)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- E narrowed by the caller's Fallback signature
    return createElement(Fallback, { error: props.error, tagged: tagged as E })
  })
}
