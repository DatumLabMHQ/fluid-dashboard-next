import { NextResponse } from "next/server"
import { buildSignals } from "@/lib/signals"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * GET /api/signals
 *
 * Machine-readable metric feed for the datumlabs-alerts Worker. Public and
 * key-free on purpose: it exposes nothing the dashboard doesn't already
 * render, and keeping it unauthenticated means the Worker needs no secret
 * for this repo.
 *
 * Returns 200 with a partial payload when a sub-builder fails (the failure is
 * listed under `degraded`) rather than 500, so one broken upstream doesn't
 * blind every rule that reads this feed.
 */
export async function GET() {
  try {
    const payload = await buildSignals()
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    })
  } catch (e: any) {
    return NextResponse.json(
      { protocol: "fluid", fetchedAt: Math.floor(Date.now() / 1000), metrics: [], error: e?.message ?? "failed" },
      { status: 503 },
    )
  }
}
