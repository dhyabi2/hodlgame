import { NextResponse } from "next/server";
import { detail } from "../../../server/market";
import { withCacheHeaders, wantsFresh } from "../_cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const tokenId = u.searchParams.get("token");
  const account = u.searchParams.get("account") ?? "";
  if (!tokenId) return NextResponse.json({ error: "token required" }, { status: 400 });
  try {
    const token = await detail(tokenId, account, wantsFresh(req));
    return token
      ? withCacheHeaders(NextResponse.json({ token }))
      : NextResponse.json({ error: "unknown token" }, { status: 404 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}