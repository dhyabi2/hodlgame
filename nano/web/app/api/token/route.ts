import { NextResponse } from "next/server";
import { detail, cachedPayload } from "../../../server/market";
import { withCacheHeaders, wantsFresh, shapeFor } from "../_cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const tokenId = u.searchParams.get("token");
  const account = u.searchParams.get("account") ?? "";
  if (!tokenId) return NextResponse.json({ error: "token required" }, { status: 400 });
  try {
    const fresh = wantsFresh(req);
    if (account) {
      const token = await detail(tokenId, account, fresh);
      return token
        ? withCacheHeaders(NextResponse.json({ token }))
        : NextResponse.json({ error: "unknown token" }, { status: 404 });
    }
    let missing = false;
    const json = await cachedPayload(`token-${tokenId}`, fresh, async () => {
      const token = await detail(tokenId, "", true);
      if (!token) missing = true;
      return { token };
    });
    if (missing) return NextResponse.json({ error: "unknown token" }, { status: 404 });
    return withCacheHeaders(new NextResponse(json, { headers: { "content-type": "application/json" } }));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}