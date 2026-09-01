import { NextResponse } from "next/server";
import { ranksFeed } from "../../../server/market";
import { computeLeaderboards } from "../../../server/leaderboards";
import { cachedPayload } from "../../../server/market";
import { withCacheHeaders, wantsFresh } from "../_cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Derived status surfaces — token/creator/holder leaderboards computed purely
// from the replayed market state (docs/GROWTH-MECHANICS.md §4).
export async function GET(req: Request) {
  try {
    // Cached on the chain fingerprint like the other fold-backed routes. This
    // is polled by the Ranks tab and every poll was a full fold.
    const json = await cachedPayload("leaderboards", wantsFresh(req), async () => {
      // ranksFeed keeps topHolders + trades (feed() strips them), so the holders
      // board and wash-resistant volume/holders boards are populated.
      const tokens = await ranksFeed("", true);
      return computeLeaderboards(tokens, Date.now(), 15);
    });
    return withCacheHeaders(new NextResponse(json, { headers: { "content-type": "application/json" } }));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
