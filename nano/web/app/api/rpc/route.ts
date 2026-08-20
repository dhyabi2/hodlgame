import { NextResponse } from "next/server";
import { nanoRpc, loadNanoRpcKey } from "../../../lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Proxy to rpc.nano.to — keeps the API key server-side. */
export async function POST(req: Request) {
  const body = await req.json();
  try {
    const result = await nanoRpc(loadNanoRpcKey(), body);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}
