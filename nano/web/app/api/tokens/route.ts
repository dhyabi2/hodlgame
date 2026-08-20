import { NextResponse } from "next/server";
import { registerToken } from "../../../server/tokens";
import { isTokenId, sanitizeMeta } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Register a launched token's metadata (called by the launch UI after broadcast). */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const tokenId = body?.tokenId;
  if (!isTokenId(tokenId)) {
    return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
  }
  try {
    // sanitizeMeta clamps decimals to 0..18 and drops non-http(s) URLs (XSS).
    await registerToken(tokenId, sanitizeMeta(body));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}