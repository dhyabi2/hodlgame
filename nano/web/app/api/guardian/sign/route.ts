import { NextResponse } from "next/server";
import * as nanocurrency from "nanocurrency";
import { guardianKeys } from "../../../../server/custody";
import { loadJson, saveJson } from "../../../../server/store";
import { nanoRpc, loadNanoRpcKey } from "../../../../lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guardian co-signer as a serverless function (2-of-3 custody). Holds its own
 * independent GUARDIAN_SEED, re-verifies the guarded pool + balance + a fresh
 * requestId (durable replay protection), recomputes the block hash, and signs.
 */
export async function POST(req: Request) {
  let r: any;
  try {
    r = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const seed = process.env.GUARDIAN_SEED;
  if (!seed) return NextResponse.json({ error: "GUARDIAN_SEED not set" }, { status: 500 });

  // Fail CLOSED: never operate as an open signing oracle. A guardian that holds
  // a seed MUST also have a shared API key configured, and callers must present
  // it. (Previously an unset GUARDIAN_KEY skipped auth entirely.)
  const apiKey = process.env.GUARDIAN_KEY;
  if (!apiKey) return NextResponse.json({ error: "GUARDIAN_KEY not configured" }, { status: 500 });
  if (r.apiKey !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  // Fail CLOSED on the pool allow-list too: an unset/empty GUARDED_POOLS must
  // reject, never accept-all. A guardian only ever co-signs for pools it was
  // explicitly told to guard.
  const guarded = new Set((process.env.GUARDED_POOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const account = String(r.account ?? "");
  if (guarded.size === 0 || !guarded.has(account)) {
    return NextResponse.json({ error: "not a guarded pool" }, { status: 400 });
  }

  const balance = String(r.balance ?? "");
  if (!/^[0-9]+$/.test(balance) || BigInt(balance) < 0n) {
    return NextResponse.json({ error: "bad balance" }, { status: 400 });
  }

  const rid = String(r.requestId ?? "");
  if (!rid) return NextResponse.json({ error: "requestId required" }, { status: 400 });
  const nonceKey = `guardian_nonce:${rid}`;
  const dup = await loadJson<number>(nonceKey);
  if (dup && Date.now() - dup < 3_600_000) {
    return NextResponse.json({ error: "duplicate request" }, { status: 409 });
  }

  const previous = String(r.previous ?? "");
  // Re-verify against the chain rather than blindly signing caller-supplied
  // fields (a blind hash-signing oracle would let a caller get ANY block
  // signed). The guardian independently confirms: (1) `previous` is the pool's
  // current confirmed frontier (no fork / no arbitrary root), and (2) the block
  // is a SEND that REDUCES the balance (funds leave the pool, never a
  // balance-inflating receive smuggled through the payout path).
  let info: any;
  try {
    info = await nanoRpc(loadNanoRpcKey(), { action: "account_info", account, representative: true });
  } catch {
    return NextResponse.json({ error: "cannot verify pool on-chain" }, { status: 502 });
  }
  if (!info?.frontier || info.frontier.toUpperCase() !== previous.toUpperCase()) {
    return NextResponse.json({ error: "previous is not the pool frontier" }, { status: 409 });
  }
  if (!(BigInt(balance) < BigInt(info.balance ?? "0"))) {
    return NextResponse.json({ error: "not a send (balance must decrease)" }, { status: 400 });
  }

  const hash = (nanocurrency as any).hashBlock({
    account,
    previous,
    representative: String(r.representative ?? ""),
    balance,
    link: String(r.link ?? ""),
  });

  const key = guardianKeys(seed);
  const signature = (nanocurrency as any).signBlock({ hash, secretKey: key.secretKey });

  await saveJson(nonceKey, Date.now());
  // Return ONLY the signature. Guardian identity (pubkey/address) is disclosed
  // through a separate enrollment step, so a single sign call never leaks the
  // cosigner's key to an unauthenticated caller.
  return NextResponse.json({ signature });
}