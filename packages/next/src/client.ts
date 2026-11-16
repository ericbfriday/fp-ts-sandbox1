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
import { catchError } from "next/error"
import { createElement, type ComponentType, type ReactNode } from "react"
import type { TaggedError } from "@friday-friday/core"

export interface BoundaryProps<E extends TaggedError<string>> {
  /** The raw thrown Error (production redacts `message` to a `digest`). */
  readonly error: unknown
  /** The decoded tagged error from `toThrowable`'s `data` attachment, if present. */
  readonly tagged: E | undefined
}

type CatchErrorProps = { readonly error?: unknown }

/** Decode the tagged error that `toThrowable` attached as `data`, defensively (wire data). */
const extractTagged = <E extends TaggedError<string>>(error: unknown): E | undefined => {
  const data = (error as { data?: unknown } | undefined)?.data
  if (typeof data === "object" && data !== null && "_tag" in data) {
    return data as E
  }
  return undefined
}

/**
 * Wrap Next.js `catchError` so the tagged error attached by `toThrowable` (via server-side
 * `orThrow`) is decoded into `props.tagged` before rendering the fallback.
 */
export function resultBoundary<E extends TaggedError<string>>(
  Fallback: (props: BoundaryProps<E>) => ReactNode
): ComponentType<{ children?: ReactNode }> {
  return catchError<CatchErrorProps>((props) =>
    createElement(Fallback, { error: props.error, tagged: extractTagged<E>(props.error) })
  )
}
