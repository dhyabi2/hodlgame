import { NextResponse } from "next/server";
import { feed } from "../../../server/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  try {
    return NextResponse.json({ tokens: await feed(account) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}