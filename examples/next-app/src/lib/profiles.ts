/**
 * Fake profile store. In a real app this is a DB layer; here it proves the Result flow
 * end-to-end without infrastructure.
 */
import { type AsyncResult, err, type ErrorFactory, ok, taggedError } from "@friday-friday/core"

export const NotFound: ErrorFactory<"NotFound", { readonly id: string }> = taggedError("NotFound")<{
  readonly id: string
}>()
export type NotFound = ReturnType<typeof NotFound>

export const Conflict: ErrorFactory<"Conflict", { readonly field: string }> = taggedError("Conflict")<{
  readonly field: string
}>()
export type Conflict = ReturnType<typeof Conflict>

export interface Profile {
  readonly id: string
  readonly displayName: string
  readonly bio: string
}

const store = new Map<string, Profile>([
  ["u_1", { id: "u_1", displayName: "Ada Lovelace", bio: "First programmer." }]
])

export function getProfile(id: string): AsyncResult<Profile, NotFound> {
  return (async () => {
    const hit = store.get(id)
    return hit !== undefined ? ok(hit) : err(NotFound({ id }))
  })()
}

export function saveProfile(
  id: string,
  input: { readonly displayName: string; readonly bio: string }
): AsyncResult<Profile, NotFound | Conflict> {
  return (async () => {
    const hit = store.get(id)
    if (hit === undefined) return err(NotFound({ id }))
    // A display name already taken by ANOTHER profile is a domain conflict.
    for (const p of store.values()) {
      if (p.id !== id && p.displayName.toLowerCase() === input.displayName.toLowerCase()) {
        return err(Conflict({ field: "displayName" }))
      }
    }
    const updated: Profile = { ...hit, displayName: input.displayName, bio: input.bio }
    store.set(id, updated)
    return ok(updated)
  })()
}

export type ProfileError = NotFound | Conflict
