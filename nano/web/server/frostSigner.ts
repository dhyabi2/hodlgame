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

import type { PoolKeys, Payout } from "./custody";

export function frostEnabled(): boolean {
  return Boolean(process.env.FROST_COORDINATOR_URL);
}

/** Ask the HoldFun FROST coordinator to threshold-sign a payout. Returns the
 * broadcastable block (nano `signature` set to the aggregated group signature)
 * or throws if the group could not reach a quorum / a cosigner rejected the
 * payout as not a legitimate obligation. */
export async function frostSignPayout(pool: PoolKeys, tokenId: string, payout: Payout): Promise<any> {
  const url = process.env.FROST_COORDINATOR_URL!;
  const key = process.env.FROST_COORDINATOR_KEY ?? "";
  const res = await fetch(url.replace(/\/$/, "") + "/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "X-Holdfun-Key": key } : {}) },
    // The coordinator rebuilds the block hash from these fields, runs the FROST
    // round, and returns the block with the group signature. `context` is the
    // policy payload each cosigner independently verifies (see verifyPayout).
    body: JSON.stringify({
      tokenId,
      pool: pool.address,
      poolPublicKey: pool.publicKey,
      block: {
        account: pool.address,
        previous: payout.frontier,
        representative: payout.representative,
        balance: (BigInt(payout.balance) - BigInt(payout.amountRaw)).toString(),
        link: payout.to,
      },
      context: {
        type: "holdfun-payout",
        tokenId,
        to: payout.to,
        amountRaw: payout.amountRaw,
      },
    }),
    signal: AbortSignal.timeout(180_000), // FROST round + cosigner replay
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`frost coordinator ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = (await res.json()) as { block?: any; error?: string };
  if (j.error || !j.block) throw new Error(j.error ?? "coordinator returned no block");
  return j.block;
}
