import { NextResponse } from "next/server";
import { commentsFor, addComment } from "../../../server/comments";
import { isTokenId, isNanoAddress } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tokenId = new URL(req.url).searchParams.get("token");
  if (!isTokenId(tokenId)) return NextResponse.json({ error: "token required" }, { status: 400 });
  return NextResponse.json({ comments: await commentsFor(tokenId) });
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const tokenId = body?.tokenId;
  const account = body?.account;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  // NOTE: `account` is only format-checked here — the comment author is not
  // cryptographically proven. The UI must not treat it as an authenticated
  // identity (see the dev-badge note in page.tsx).
  if (!isTokenId(tokenId) || !isNanoAddress(account) || !text) {
    return NextResponse.json({ error: "valid tokenId, account and text required" }, { status: 400 });
  }
  const comment = await addComment(tokenId, account, text);
  return NextResponse.json({ comment });
}