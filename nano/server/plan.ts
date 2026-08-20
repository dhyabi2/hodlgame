// Pure sell-payout planning (no network, no keys). Given the multi-token state
// and the on-chain sell ops, compute how much XNO each token's pool owes a
// seller. The sweep layer turns these plans into signed Nano sends.

import type { MultiState } from "../core/multi";
import type { SellRecord } from "../indexer/multiIndexer";

export interface Payout {
  tokenId: string;
  to: string; // recipient nano_ address
  amountRaw: bigint; // XNO out, in raw
  hash: string; // sell block hash (idempotency key)
}

export interface Skip {
  tokenId: string;
  hash: string;
  reason: string;
}

export interface SweepPlan {
  payouts: Payout[];
  skipped: Skip[];
}

export function planSellPayouts(state: MultiState, sells: SellRecord[]): SweepPlan {
  const payouts: Payout[] = [];
  const skipped: Skip[] = [];
  for (const s of sells) {
    const token = state.get(s.tokenId);
    if (!token || token.poolXno <= 0n || token.poolTokens <= 0n) {
      skipped.push({ tokenId: s.tokenId, hash: s.hash, reason: "no liquidity" });
      continue;
    }
    const out = (s.tokens * token.poolXno) / (token.poolTokens + s.tokens);
    if (out < s.minXno) {
      skipped.push({ tokenId: s.tokenId, hash: s.hash, reason: "slippage" });
      continue;
    }
    if (out <= 0n || out >= token.poolXno) {
      skipped.push({ tokenId: s.tokenId, hash: s.hash, reason: "exceeds reserve" });
      continue;
    }
    payouts.push({ tokenId: s.tokenId, to: s.sender, amountRaw: out, hash: s.hash });
  }
  return { payouts, skipped };
}