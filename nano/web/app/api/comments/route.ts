import { NextResponse } from "next/server";
import { commentsFor, addComment } from "../../../server/comments";
import { isTokenId, isNanoAddress } from "../../../server/validate";
import { rateLimit, clientIp } from "../../../server/httpguard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // The POST path is throttled; GET was not, yet each read loads+parses the
  // whole comments store. Rate-limit reads too so a loop can't run up
  // blob-egress/CPU cost.
  const ip = clientIp(req);
  if (!rateLimit(`cmtGET:${ip}`, 120, 60_000) || !rateLimit("cmtGET:global", 1200, 60_000)) {
    return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
  }
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
  // Reject oversized bodies before buffering them into memory (OOM guard — a
  // comment JSON is tiny; the same guard the upload route uses). req.json()
  // would otherwise parse tens of MB before the 280-char/signature checks run.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 4096) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
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
