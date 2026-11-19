/**
 * What the profile form shows for an action state. Pure, so the feature test covers it without
 * rendering React.
 *
 * - `ValidationFailure` → per-field messages from schema's `toFieldErrors` (no hand-rolled
 *   flattener); root-level issues (`_errors`) become the form-level message.
 * - Every other error → one human sentence chosen by `_tag`. The table is typed by the action's
 *   error union, so a new error tag fails to compile until it gets a message. `InternalDefect`
 *   carries only fixed text from the server; the form shows its own wording.
 */
import type { ActionState } from "@friday-friday/next"
import { toFieldErrors } from "@friday-friday/schema"
import type { Profile, ProfileError } from "../../lib/profiles"
import type { Forbidden } from "./actions"

export type ProfileActionState = ActionState<Profile, Forbidden | ProfileError>

type ActionError = Extract<ProfileActionState, { readonly ok: false }>["error"]

export interface FormErrors {
  /** Form-level message: non-validation errors and root-level validation issues. */
  readonly form?: string
  /** Field name → messages. */
  readonly fields: Readonly<Record<string, ReadonlyArray<string>>>
}

const messages: { readonly [Tag in Exclude<ActionError["_tag"], "ValidationFailure">]: string } = {
  Forbidden: "You can't update this profile. Sign in and try again.",
  NotFound: "This profile no longer exists.",
  Conflict: "That display name is already taken.",
  InternalDefect: "Something went wrong on our side. Please try again."
}

export function formErrorsOf(state: ProfileActionState): FormErrors {
  if (state.ok !== false) return { fields: {} }
  const error = state.error
  if (error._tag !== "ValidationFailure") return { form: messages[error._tag], fields: {} }
  const { _errors: root, ...fields } = toFieldErrors(error)
  return root === undefined ? { fields } : { form: root.join(" "), fields }
}
