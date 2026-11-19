/**
 * Fake session guard (a real app would read cookies via better-auth). Same fixed tag as
 * `@friday-friday/better-auth` (core's `Unauthenticated`, ADR-0005) so the pattern transfers 1:1.
 */
import { err, type ErrorFactory, type Result, taggedError } from "@friday-friday/core"

/** Extension of core's `Unauthenticated` (ADR-0005): adds only an OPTIONAL `where?`. */
export const Unauthenticated: ErrorFactory<"Unauthenticated", { readonly where?: string }> = taggedError(
  "Unauthenticated"
)<{ readonly where?: string }>()
export type Unauthenticated = ReturnType<typeof Unauthenticated>

export interface Session {
  readonly userId: string
}

/**
 * Request-scoped session lookup. The demo store has exactly one live session; a missing
 * one is `Err(Unauthenticated)` and NEVER a throw — guards compose with andThen.
 */
const sessions = new Set<string>(["u_1"])

export function requireSession(userId: string, where: string): Result<Session, Unauthenticated> {
  return sessions.has(userId) ? { ok: true as const, value: { userId } } : err(Unauthenticated({ where }))
}
