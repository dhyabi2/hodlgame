import { NextResponse } from "next/server";
import { runSweep } from "../../../../server/operator";

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
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}