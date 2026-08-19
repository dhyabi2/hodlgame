import { NextResponse } from "next/server";
import { snapshotPrices } from "@/lib/server/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel Cron endpoint: snapshots every live token's price into KV so the
 * market API can compute 24h price change. Secured by `CRON_SECRET` — Vercel
 * sends it in the Authorization header; reject everything else.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const written = await snapshotPrices();
    return NextResponse.json({ ok: true, written });
  } catch (err) {
    console.error("snapshot cron failed", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
