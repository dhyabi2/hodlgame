import { NextResponse } from "next/server";
import { marketStats } from "@/lib/server/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public market data: per-mint 24h price change (and current price/market cap).
 * The frontend merges this into the directory for the "performance" column and
 * the Hot list. Degrades gracefully to null change when KV isn't configured.
 */
export async function GET() {
  try {
    const stats = await marketStats();
    return NextResponse.json(stats, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
    });
  } catch (err) {
    console.error("market stats failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
