import { NextResponse } from "next/server";
import { runSweep } from "../../../../server/operator";
import { gcOrphanImages } from "../../../../server/imagegc";
import { refreshXnoUsd } from "../../../../server/xnoUsd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel cron endpoint. Triggered by `vercel.json` crons with
 * `Authorization: Bearer ${CRON_SECRET}`. Runs one sweep: receive buys, pay
 * sells, refund rejected buys.
 */
export async function GET(req: Request) {
  // Fail CLOSED: an unset secret must NOT open the sweep to anonymous callers
  // (it drives the on-chain payout loop). Vercel Cron sets this header.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await runSweep(null);
    // Best-effort orphan-image GC — never let it fail the payout sweep.
    let gc: unknown = null;
    try { gc = await gcOrphanImages(); } catch (e: any) { gc = { error: e?.message ?? String(e) }; }
    // Refresh the XNO→USD rate once per cron tick so no user ever hits CoinGecko.
    let usd: number | null = null;
    try { usd = await refreshXnoUsd(); } catch {}
    // NOTE: this used to pre-warm the market cache with a full feed() here.
    // Removed: it is a whole chain fold every 60s, and it only paid off while
    // the cache was actually hitting — under the current RPC ceiling it was
    // pure extra load competing with real user requests.
    return NextResponse.json({ ...r, gc, usd });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}