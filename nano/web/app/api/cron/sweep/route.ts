import { NextResponse } from "next/server";
import { runSweep } from "../../../../server/operator";
import { gcOrphanImages } from "../../../../server/imagegc";
import { refreshXnoUsd } from "../../../../server/xnoUsd";
import { feed, cacheInfo } from "../../../../server/market";

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
    // Pre-warm the market cache on this instance so a user arriving after a
    // change lands on a warm fold instead of paying for the full chain walk.
    // Best-effort: a failure here must never affect the payout sweep.
    let warm: unknown = null;
    try {
      const t0 = Date.now();
      await feed("");
      warm = { ms: Date.now() - t0, ...cacheInfo() };
    } catch (e: any) {
      warm = { error: e?.message ?? String(e) };
    }
    return NextResponse.json({ ...r, gc, usd, warm });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}