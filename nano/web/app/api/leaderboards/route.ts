import { NextResponse } from "next/server";
import { feed } from "../../../server/market";
import { computeLeaderboards } from "../../../server/leaderboards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Derived status surfaces — token/creator/holder leaderboards computed purely
// from the replayed market state (docs/GROWTH-MECHANICS.md §4).
export async function GET() {
  try {
    const tokens = await feed("");
    return NextResponse.json(computeLeaderboards(tokens, Date.now(), 15));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
