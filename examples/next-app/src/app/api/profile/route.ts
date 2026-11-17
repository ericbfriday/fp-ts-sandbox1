/**
 * Route handler: GET /api/profile?id=u_1 — the server-to-server face of the same feature.
 * Ok renders JSON; every Err renders an RFC 9457 problem+json via toResponse with literal
 * status mapping (the contract @friday-friday/http's fetchResult round-trips losslessly).
 */
import { toResponse } from "@friday-friday/next"
import type { NextRequest } from "next/server"
import { getProfile } from "../../../lib/profiles"

// Literal statuses keep the client-side inference narrow (spec 5.2); the map is validated
// structurally by toResponse at runtime.
const statuses = { NotFound: 404 } as const

export async function GET(request: NextRequest): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "u_1"
  return toResponse(await getProfile(id), statuses)
}
