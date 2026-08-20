import { NextResponse } from "next/server";
import { registerToken } from "../../../server/tokens";

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
  if (!tokenId || typeof tokenId !== "string" || tokenId.length !== 32) {
    return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
  }
  await registerToken(tokenId, {
    name: String(body.name ?? ""),
    symbol: String(body.symbol ?? ""),
    decimals: Number(body.decimals ?? 6),
    image: String(body.image ?? ""),
    description: String(body.description ?? ""),
    website: String(body.website ?? ""),
    twitter: String(body.twitter ?? ""),
    telegram: String(body.telegram ?? ""),
  });
  return NextResponse.json({ ok: true });
}