import { NextResponse } from "next/server";
import { detail } from "../../../server/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tokenId = new URL(req.url).searchParams.get("token");
  if (!tokenId) return NextResponse.json({ error: "token required" }, { status: 400 });
  try {
    const token = await detail(tokenId);
    return token
      ? NextResponse.json({ token })
      : NextResponse.json({ error: "unknown token" }, { status: 404 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}