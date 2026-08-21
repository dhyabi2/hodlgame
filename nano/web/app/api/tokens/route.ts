import { NextResponse } from "next/server";
import { loadMetaRow, saveMetaRow } from "../../../server/tokens";
import { isTokenId, sanitizeMeta, metaHasRequired } from "../../../server/validate";
import { verifyMetaSignature, decideMetaUpdate, gateMetaAction } from "../../../server/metaAuth";
import { authorityStateOf } from "../../../server/market";
import { rateLimit, clientIp } from "../../../server/httpguard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Register / update a launched token's metadata. Signed-only: the payload must
 * carry { account, signature, seq, action } where `signature` is the creator's
 * ed25519-blake2b signature over the domain-separated digest of the SANITIZED
 * fields (core/metaAuth.ts). Authority = the on-chain launch signer; before the
 * launch is indexed the first valid signer holds provisional authority, which
 * the real creator overrides as soon as the chain catches up.
 */
export async function POST(req: Request) {
  let body: any;
  const ip = clientIp(req);
  if (!rateLimit(`meta:${ip}`, 20, 60_000) || !rateLimit("meta:global", 240, 60_000)) {
    return NextResponse.json({ error: "rate limited — try again shortly" }, { status: 429 });
  }
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const tokenId = body?.tokenId;
  if (!isTokenId(tokenId)) {
    return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
  }

  // sanitizeMeta normalizes text (strips control/bidi/zero-width), restricts the
  // symbol to ASCII, drops http/unsafe image URLs, and caps lengths. The client
  // signs the sanitized fields, so verification runs on the same bytes.
  const meta = sanitizeMeta(body);
  if (!metaHasRequired(meta)) {
    return NextResponse.json({ error: "name and symbol are required" }, { status: 400 });
  }
  const update = {
    tokenId,
    meta,
    account: String(body?.account ?? ""),
    signature: String(body?.signature ?? ""),
    seq: Number(body?.seq ?? 0),
    action: String(body?.action ?? "update"),
  };
  if (!verifyMetaSignature(update)) {
    return NextResponse.json({ error: "invalid or missing creator signature" }, { status: 401 });
  }

  try {
    const prev = await loadMetaRow(tokenId);
    // Chain-derived authority state: launch creator folded over on-chain
    // immutable/setAuthority anchors. Once indexed, it overrides the store —
    // a successor with an empty database still enforces the right owner.
    const chain = await authorityStateOf(tokenId);
    const gate = gateMetaAction(update.action, chain);
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error }, { status: gate.code });
    }
    const decision = decideMetaUpdate(update, prev, chain?.authority ?? null);
    if (!decision.ok) {
      return NextResponse.json({ error: decision.error }, { status: decision.code });
    }
    await saveMetaRow(tokenId, meta, decision.row);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
