// Deterministic buy reconciliation. A buy is two blocks: an op block declaring
// the xno amount (with optional slippage) and a separate native XNO send to the
// pool. The indexer credits poolXno only from *valid* buy ops, so a rejected
// buy (e.g. slippage) leaves its XNO in the pool uncredited.
//
// Refund rule (safe — never trusts the declared xno):
//   refund[sender] = poolReceived[sender] - creditedBuyXno[sender]   (if > 0)
// Where poolReceived is the XNO that actually arrived from `sender` in the pool
// account, and creditedBuyXno is the xno of `sender`'s *valid* buy ops. Honest
// rejected buys (declared == sent) therefore refund exactly what arrived; a
// sender who never sent XNO has poolReceived 0 and can never drain the pool.

import { applyBlock, multiEmpty, type MultiState } from "../core/multi";
import type { IndexedEvent } from "../indexer/multiIndexer";

/** tokenId → (sender → xno credited by valid buy ops). */
export type TokenCredits = Map<string, Map<string, bigint>>;

export function creditedBuys(events: IndexedEvent[]): TokenCredits {
  let s: MultiState = multiEmpty();
  const credits: TokenCredits = new Map();
  for (const ev of events) {
    let next;
    try {
      next = applyBlock(s, ev);
    } catch {
      continue; // rejected op → not credited
    }
    s = next;
    if (ev.op.kind === "buy") {
      const bySender = credits.get(ev.tokenId) ?? new Map<string, bigint>();
      bySender.set(ev.sender, (bySender.get(ev.sender) ?? 0n) + ev.op.xno);
      credits.set(ev.tokenId, bySender);
    }
  }
  return credits;
}

export function computeRefunds(
  poolReceived: Map<string, bigint>,
  credited: Map<string, bigint>
): Map<string, bigint> {
  const refunds = new Map<string, bigint>();
  for (const [sender, received] of poolReceived) {
    const cred = credited.get(sender) ?? 0n;
    if (received > cred) refunds.set(sender, received - cred);
  }
  return refunds;
}