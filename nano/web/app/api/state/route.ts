import { NextResponse } from "next/server";
import { feed, cachedPayload } from "../../../server/market";
import { withCacheHeaders, wantsFresh } from "../_cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  try {
    const fresh = wantsFresh(req);
    // Only the anonymous feed is shared across instances — a per-account
    // payload embeds that account's balances and must not be handed to anyone
    // else, so those keep the (correct, per-instance) path.
    const json = account
      ? JSON.stringify({ tokens: await feed(account, fresh) })
      : await cachedPayload("state", fresh, async () => ({ tokens: await feed("", fresh) }));
    return withCacheHeaders(new NextResponse(json, { headers: { "content-type": "application/json" } }));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}