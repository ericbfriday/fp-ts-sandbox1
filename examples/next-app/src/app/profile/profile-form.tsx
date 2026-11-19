"use client"

/**
 * The form face of the feature: useActionState drives the server action; ValidationFailure
 * field errors arrive as DATA (form state survives — report §5.1 trap 3). What to show for each
 * state lives in `form-errors.ts` (schema's `toFieldErrors` + a human message per error tag).
 */
import { type ReactElement, useActionState } from "react"
import { updateProfile } from "../../app/profile/actions"
import { formErrorsOf } from "./form-errors"

export function ProfileForm(props: {
  readonly initialDisplayName: string
  readonly initialBio: string
}): ReactElement {
  const [state, formAction, pending] = useActionState(updateProfile, { ok: null })
  const { form, fields } = formErrorsOf(state)
  const displayName = fields["displayName"]
  const bio = fields["bio"]

  return (
    <form action={formAction}>
      {form !== undefined && <p role="alert">{form}</p>}
      <label>
        Display name
        <input name="displayName" defaultValue={props.initialDisplayName} />
      </label>
      {displayName !== undefined && <p role="alert">{displayName.join(", ")}</p>}
      <label>
        Bio
        <textarea name="bio" defaultValue={props.initialBio} />
      </label>
      {bio !== undefined && <p role="alert">{bio.join(", ")}</p>}
      <button type="submit" disabled={pending}>
        Save
      </button>
    </form>
  )
}
