/**
 * Fake profile store. In a real app this is a DB layer; here it proves the Result flow
 * end-to-end without infrastructure. Its errors are core's fixed tags (ADR-0005), not
 * example-local factories, so every package's guard for them agrees.
 */
import { type AsyncResult, Conflict, err, NotFound, ok } from "@friday-friday/core"

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
    return hit !== undefined ? ok(hit) : err(NotFound({ resource: "profile", id }))
  })()
}

export function saveProfile(
  id: string,
  input: { readonly displayName: string; readonly bio: string }
): AsyncResult<Profile, NotFound | Conflict> {
  return (async () => {
    const hit = store.get(id)
    if (hit === undefined) return err(NotFound({ resource: "profile", id }))
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
