import { redirect } from "next/navigation"

// The app root simply forwards to the one feature (issue #9 scope).
export default function Home(): void {
  redirect("/profile")
}
