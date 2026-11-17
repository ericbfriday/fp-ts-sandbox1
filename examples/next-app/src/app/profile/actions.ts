"use server"

/**
 * Profile update action - the ONE feature of this example (issue #9), end-to-end on Result:
 * FormData -> Standard Schema (ValidationFailure field errors) -> session guard -> save ->
 * redirect() after a successful save. The redirect sentinel is thrown INSIDE the handler;
 * action()'s triage must rethrow it (control flow wins over form state) - that is the
 * exit criterion under test.
 */
import { redirect } from "next/navigation"
import { z } from "zod"
import { err, taggedError, type AsyncResult, type ErrorFactory } from "@friday-friday/core"
import { andThenAsync, mapAsync, orElseAsync } from "@friday-friday/core/async"
import { action, type ActionFn } from "@friday-friday/next"
import { saveProfile, type Profile, type ProfileError } from "../../lib/profiles"
import { requireSession } from "../../lib/session"

export const Forbidden: ErrorFactory<"Forbidden", { readonly action: string }> = taggedError("Forbidden")<{
  readonly action: string
}>()
export type Forbidden = ReturnType<typeof Forbidden>

export interface ProfileInputValues {
  readonly displayName: string
  readonly bio: string
}

export const ProfileInput: z.ZodObject<{
  displayName: z.ZodString
  bio: z.ZodString
}> = z.object({
  displayName: z.string().min(2, "Display name needs at least 2 characters"),
  bio: z.string().max(280, "Bio must be 280 characters or fewer")
})

export const updateProfile: ActionFn<Profile, Forbidden | ProfileError> = action(
  ProfileInput,
  (input: ProfileInputValues): AsyncResult<Profile, Forbidden | ProfileError> => {
    // Guard failure maps into the action's own vocabulary (Forbidden); then save.
    const authorized = orElseAsync(requireSession("u_1", "updateProfile"), () =>
      err(Forbidden({ action: "updateProfile" }))
    )
    const guarded = andThenAsync(authorized, () => saveProfile("u_1", input))
    return mapAsync(guarded, (profile) => {
      // Sentinel control flow AFTER a successful save - the whole point of the example.
      redirect(`/profile/saved?id=${encodeURIComponent(profile.id)}`)
      // Unreachable when the sentinel fires; keeps the mapper's value shape.
      return profile
    })
  },
  { onDefect: (cause) => {
      // Demo sink for defects (a real app would log to otel/sentry).
      void cause
    } }
)
