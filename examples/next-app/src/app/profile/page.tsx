/**
 * Profile page — the loader face: orNotFound turns a missing profile into Next's
 * `notFound()` sentinel (which the adapter rethrows past any try/catch).
 */
import { err, matchTag } from "@friday-friday/core"
import { orNotFound } from "@friday-friday/next"
import { getProfile, NotFound } from "../../lib/profiles"
import { requireSession } from "../../lib/session"
import { ProfileForm } from "./profile-form"

export default async function ProfilePage(): Promise<React.ReactElement> {
  // Guard first, then load — plain Result flow, no throws in user code. A failed guard is
  // reported as NotFound (the page does not reveal whether the profile exists), so
  // orNotFound handles both. It removes NotFound from E, leaving `ok` as the only case.
  const guard = requireSession("u_1", "profilePage")
  const loaded = guard.ok ? await getProfile("u_1") : err(NotFound({ id: "u_1" }))
  return matchTag(orNotFound(loaded), {
    ok: (profile) => (
      <main>
        <h1>Profile</h1>
        <ProfileForm initialDisplayName={profile.displayName} initialBio={profile.bio} />
      </main>
    )
  })
}
