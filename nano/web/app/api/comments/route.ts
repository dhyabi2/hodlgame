import { NextResponse } from "next/server";
import { commentsFor, addComment } from "../../../server/comments";
import { isTokenId, isNanoAddress } from "../../../server/validate";
import { rateLimit, clientIp } from "../../../server/httpguard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tokenId = new URL(req.url).searchParams.get("token");
  if (!isTokenId(tokenId)) return NextResponse.json({ error: "token required" }, { status: 400 });
  return NextResponse.json({ comments: await commentsFor(tokenId) });
}

/** Signed-only: the author signs blake2b("holdfun-comment-v1"‖tokenId‖time‖text)
 * with their wallet key; authorship is cryptographic, not claimed. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`cmt:${ip}`, 30, 60_000) || !rateLimit("cmt:global", 300, 60_000)) {
    return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const tokenId = body?.tokenId;
  const account = body?.account;
  if (!isTokenId(tokenId) || !isNanoAddress(account)) {
    return NextResponse.json({ error: "valid tokenId and account required" }, { status: 400 });
  }
  const r = await addComment(
    tokenId,
    account,
    String(body?.text ?? ""),
    Number(body?.time ?? 0),
    String(body?.signature ?? "")
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 401 });
  return NextResponse.json({ comment: r.comment });
}
