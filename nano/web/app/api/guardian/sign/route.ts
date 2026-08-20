import { NextResponse } from "next/server";
import * as nanocurrency from "nanocurrency";
import { guardianKeys } from "../../../../server/custody";
import { loadJson, saveJson } from "../../../../server/store";

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

  const apiKey = process.env.GUARDIAN_KEY;
  if (apiKey && r.apiKey !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  const seed = process.env.GUARDIAN_SEED;
  if (!seed) return NextResponse.json({ error: "GUARDIAN_SEED not set" }, { status: 500 });

  const guarded = new Set((process.env.GUARDED_POOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const account = String(r.account ?? "");
  if (guarded.size > 0 && !guarded.has(account)) {
    return NextResponse.json({ error: "not a guarded pool" }, { status: 400 });
  }

  const balance = String(r.balance ?? "");
  if (!/^[0-9]+$/.test(balance) || BigInt(balance) <= 0n) {
    return NextResponse.json({ error: "bad balance" }, { status: 400 });
  }

  const rid = String(r.requestId ?? "");
  if (!rid) return NextResponse.json({ error: "requestId required" }, { status: 400 });
  const nonceKey = `guardian_nonce:${rid}`;
  const prev = await loadJson<number>(nonceKey);
  if (prev && Date.now() - prev < 3_600_000) {
    return NextResponse.json({ error: "duplicate request" }, { status: 409 });
  }

  const hash = (nanocurrency as any).hashBlock({
    account,
    previous: String(r.previous ?? ""),
    representative: String(r.representative ?? ""),
    balance,
    link: String(r.link ?? ""),
  });

  const key = guardianKeys(seed);
  const signature = (nanocurrency as any).signBlock({ hash, secretKey: key.secretKey });

  await saveJson(nonceKey, Date.now());
  return NextResponse.json({ signature, publicKey: key.publicKey, account: key.address });
}