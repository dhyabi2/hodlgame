// FROST 2-of-3 custody client (roadmap W1). Replaces single-key pool signing
// with a threshold signature produced by an independent signer group, reusing
// the production blake2b-FROST stack from verifyXNOPrivacyProtocol (BlackBird/
// VELA): a HoldFun coordinator drives the commit→sign→aggregate round with the
// HoldFun cosigners, and EACH cosigner independently re-derives the expected
// payout from its own deterministic settlement replay (cosigner-as-verifier)
// before releasing its share. No single machine or party can move pool funds.
//
// This module is the HoldFun-TS side: it hands an unsigned payout to the FROST
// coordinator gateway and gets back a fully-signed, broadcastable block. The
// coordinator + cosigners run on the fleet (see docs/FROST-CUSTODY.md). When
// FROST_COORDINATOR_URL is unset, callers fall back to the legacy single-key
// path (unchanged), so this is opt-in per deployment.

import * as nanocurrency from "nanocurrency";
import type { PoolKeys, Payout } from "./custody";
import { nanoRpc, loadNanoRpcKey, SEND_DIFFICULTY } from "../lib/rpc";

export function frostEnabled(): boolean {
  return Boolean(process.env.FROST_COORDINATOR_URL);
}

/** Threshold-sign a payout via the HoldFun FROST group and return a
 * broadcastable block. The block HASH is computed here (crypto the operator
 * already has), the coordinator runs the FROST round over that hash + the
 * policy `context` each cosigner independently verifies, and we assemble the
 * block with the group signature + PoW. Throws if the group can't reach a
 * quorum or a cosigner rejects the payout as not owed. */
export async function frostSignPayout(pool: PoolKeys, tokenId: string, payout: Payout): Promise<any> {
  const url = process.env.FROST_COORDINATOR_URL!;
  const key = process.env.FROST_COORDINATOR_KEY ?? "";
  const balance = (BigInt(payout.balance) - BigInt(payout.amountRaw)).toString();
  const linkPub = nanocurrency.derivePublicKey(payout.to);

  // Deterministic Nano state-block hash the group will sign.
  const blockHash = nanocurrency.hashBlock({
    account: pool.address,
    previous: payout.frontier,
    representative: payout.representative,
    balance,
    link: linkPub,
  });

  const res = await fetch(url.replace(/\/$/, "") + "/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "X-Holdfun-Key": key } : {}) },
    body: JSON.stringify({
      tokenId,
      poolPublicKey: pool.publicKey,
      blockHash,
      context: { type: "holdfun-payout", tokenId, to: payout.to, amountRaw: payout.amountRaw },
    }),
    signal: AbortSignal.timeout(180_000), // FROST round + cosigner replay
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`frost coordinator ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = (await res.json()) as { signature?: string; error?: string };
  if (j.error || !j.signature) throw new Error(j.error ?? "coordinator returned no signature");

  const work = (await nanoRpc(loadNanoRpcKey(), { action: "work_generate", hash: payout.frontier, difficulty: SEND_DIFFICULTY })).work;
  return {
    type: "state",
    account: pool.address,
    previous: payout.frontier,
    representative: payout.representative,
    balance,
    link: linkPub,
    signature: j.signature.toUpperCase(),
    work,
  };
}
