/**
 * Profile page — the loader face: orNotFound turns a missing profile into Next's
 * `notFound()` sentinel (which the adapter rethrows past any try/catch).
 */
import { err } from "@friday-friday/core"
import { orNotFound } from "@friday-friday/next"
import { ProfileForm } from "./profile-form"
import { getProfile } from "../../lib/profiles"
import { requireSession } from "../../lib/session"

export default async function ProfilePage(): Promise<React.ReactElement> {
  // Guard first, then load — plain Result flow, no throws in user code. orNotFound turns
  // ANY Err (guard failure or missing profile) into Next's notFound() sentinel.
  const guard = requireSession("u_1", "profilePage")
  const loaded = guard.ok ? await getProfile("u_1") : err(guard.error)
  const r = orNotFound(loaded)
  if (!r.ok) throw new Error("unreachable: orNotFound already threw for Err")
  return (
    <main>
      <h1>Profile</h1>
      <ProfileForm initialDisplayName={r.value.displayName} initialBio={r.value.bio} />
    </main>
  )
}
