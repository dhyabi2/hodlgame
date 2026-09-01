import { NextResponse } from "next/server";
import { feed } from "../../../server/market";
import { withCacheHeaders, wantsFresh } from "../_cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  try {
    return withCacheHeaders(NextResponse.json({ tokens: await feed(account, wantsFresh(req)) }));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}