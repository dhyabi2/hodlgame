import { NextResponse } from "next/server";
import { getXnoUsd } from "../../../server/xnoUsd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// XNO→USD rate served from the server's own store (refreshed by the cron), so
// the browser never calls CoinGecko directly (no CORS, no per-user rate limit).
export async function GET() {
  const r = await getXnoUsd();
  // Let the CDN hold the value briefly so a burst of clients shares one read;
  // the rate moves slowly, so 60s is safe and cuts load without hiding staleness.
  return NextResponse.json(r, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } });
}
