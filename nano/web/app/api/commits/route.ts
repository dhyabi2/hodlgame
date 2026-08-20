import { NextResponse } from "next/server";
import { registerCommit } from "../../../server/commits";
import { bustCache } from "../../../server/market";
import { parse } from "../../../core/json";
import { isTokenId, validateCommitOp } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Register a commit-reveal op (slippage buy/sell) and return its commit link. */
export async function POST(req: Request) {
  let body: any;
  try {
    body = parse(await req.text());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const tokenId = body?.tokenId;
  const op = body?.op;
  if (!isTokenId(tokenId) || !op || typeof op !== "object") {
    return NextResponse.json({ error: "tokenId and op required" }, { status: 400 });
  }
  const check = validateCommitOp(op);
  if (!check.ok) {
    return NextResponse.json({ error: check.reason }, { status: 400 });
  }
  try {
    const link = await registerCommit(tokenId, op);
    bustCache();
    return NextResponse.json({ ok: true, link });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}