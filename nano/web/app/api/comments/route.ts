import { NextResponse } from "next/server";
import { commentsFor, addComment } from "../../../server/comments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tokenId = new URL(req.url).searchParams.get("token");
  if (!tokenId) return NextResponse.json({ error: "token required" }, { status: 400 });
  return NextResponse.json({ comments: await commentsFor(tokenId) });
}

export async function POST(req: Request) {
  const body = await req.json();
  const tokenId = body?.tokenId;
  const account = body?.account;
  const text = body?.text;
  if (!tokenId || !account || !text) {
    return NextResponse.json({ error: "tokenId, account and text required" }, { status: 400 });
  }
  const comment = await addComment(tokenId, account, text);
  return NextResponse.json({ comment });
}