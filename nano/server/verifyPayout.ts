// Cosigner-as-verifier (roadmap W1). Each FROST cosigner MUST independently
// confirm a proposed payout is legitimate before releasing its signature
// share — threshold signing splits the key, but this check is what stops a
// compromised coordinator from getting a valid signature for a theft. Because
// HoldFun settlement is a pure function of chain data (server/settled.ts), a
// cosigner re-derives the current per-recipient obligation itself and approves
// ONLY if the proposed {tokenId, to, amountRaw} is covered by what is actually
// owed. Run on each cosigner box (its own RPC view); the Python FROST cosigner
// calls it over localhost before signing.

import { indexer, watchedAccounts } from "./operator";
import { analyze } from "./analytics";
import { creditedBuys, computeRefunds } from "./reconcile";
import { readPoolDepositsFromChain } from "./sweep";
import { poolOutgoingByRecipient, entitlementsFor, netObligations } from "./settled";
import { tokenPoolKeys } from "./custody";
import { NanoRpcSource } from "../indexer/blockSource";
import { loadNanoRpcKey } from "../lib/rpc";

export interface PayoutRequest {
  tokenId: string;
  to: string;
  amountRaw: string;
}

export type VerifyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Approve iff `to` is currently owed at least `amountRaw` for `tokenId`, per a
 * fresh chain-derived settlement replay. Fails CLOSED on any inconsistency.
 * Requires POOL_SEED locally only to derive the pool ADDRESS (to read its
 * chain) — never to sign; the FROST group signs.
 */
export async function verifyPayout(req: PayoutRequest): Promise<VerifyVerdict> {
  const masterSeed = process.env.POOL_SEED;
  if (!masterSeed) return { ok: false, reason: "POOL_SEED not set (cannot derive pool address)" };
  if (!/^[0-9a-fA-F]{32}$/.test(req.tokenId)) return { ok: false, reason: "bad tokenId" };
  let want: bigint;
  try {
    want = BigInt(req.amountRaw);
  } catch {
    return { ok: false, reason: "bad amountRaw" };
  }
  if (want <= 0n) return { ok: false, reason: "non-positive amount" };

  const key = loadNanoRpcKey();
  const idx = await indexer();
  const events = await idx.collectEvents(await watchedAccounts());

  // The pool this cosigner will be asked to sign for must be the chain-derived
  // pool (what deposits validated against) AND the custody pool — else refuse.
  const chainPool = idx.getChainPools().get(req.tokenId);
  const custodyPool = tokenPoolKeys(masterSeed, req.tokenId);
  if (!chainPool || chainPool !== custodyPool.publicKey.toLowerCase()) {
    return { ok: false, reason: "pool mismatch (non-custody or unseeded token)" };
  }

  const { sellPayouts } = analyze(events);
  const credits = creditedBuys(events).get(req.tokenId) ?? new Map<string, bigint>();
  const poolBlocks = await new NanoRpcSource(key).listBlocks(custodyPool.address);
  const poolReceived = await readPoolDepositsFromChain(key, custodyPool, poolBlocks);
  const refunds = computeRefunds(poolReceived, credits);
  const entitled = entitlementsFor(req.tokenId, sellPayouts, refunds);
  const obligations = netObligations(entitled, poolOutgoingByRecipient(poolBlocks));

  const owed = obligations.find((o) => o.recipient === req.to)?.amountRaw ?? 0n;
  if (owed < want) {
    return { ok: false, reason: `not owed: recipient owed ${owed}, requested ${want}` };
  }
  return { ok: true };
}
