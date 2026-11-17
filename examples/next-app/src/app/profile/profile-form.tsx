"use client"

/**
 * The form face of the feature: useActionState drives the server action; ValidationFailure
 * field errors arrive as DATA (form state survives — report §5.1 trap 3).
 */
import { useActionState, type ReactElement } from "react"
import { updateProfile } from "../../app/profile/actions"

/* oxlint-disable no-unsafe-type-assertion -- wire boundary: the action's error is unknown here; fields verified before use */

interface FieldErrors {
  readonly displayName?: ReadonlyArray<string>
  readonly bio?: ReadonlyArray<string>
}

// ValidationFailure carries issues[] (see @friday-friday/schema); anything else renders top-level.
// Structural probe: state error is unknown at this boundary.
// oxlint-disable-next-line no-unsafe-type-assertion
function fieldErrorsOf(error: unknown): FieldErrors {
  const issues = (error as { issues?: ReadonlyArray<{ message?: string; path?: ReadonlyArray<unknown> }> } | null)
    ?.issues
  if (issues !== undefined) {
    const out: { displayName?: Array<string>; bio?: Array<string> } = {}
    for (const issue of issues) {
      const key = issue.path !== undefined && issue.path.length > 0 ? String(issue.path[0]) : "displayName"
      out[key as "displayName" | "bio"] = [...(out[key as "displayName" | "bio"] ?? []), issue.message ?? "invalid"]
    }
    return out
  }
  return { displayName: [String(error)] }
}

export function ProfileForm(props: {
  readonly initialDisplayName: string
  readonly initialBio: string
}): ReactElement {
  const [state, formAction, pending] = useActionState(updateProfile, { ok: null })

  // state.ok === false discriminates (ok: null when idle, boolean in Result).
  const errors: FieldErrors = state.ok === false ? fieldErrorsOf(state.error) : {}

  return (
    <form action={formAction}>
      <label>
        Display name
        <input name="displayName" defaultValue={props.initialDisplayName} />
      </label>
      {errors.displayName !== undefined && <p role="alert">{errors.displayName.join(", ")}</p>}
      <label>
        Bio
        <textarea name="bio" defaultValue={props.initialBio} />
      </label>
      {errors.bio !== undefined && <p role="alert">{errors.bio.join(", ")}</p>}
      <button type="submit" disabled={pending}>
        Save
      </button>
    </form>
  )
}
