// Chain-derived settlement (roadmap W2/W4): the pool's own account chain is
// the settlement ledger. Per recipient we pay
//
//   owed = max(0, entitlement − alreadySent)
//
// where `entitlement` is the deterministic total the ledger says they are due
// (sell payouts + buy refunds, netted together) and `alreadySent` is the sum
// of the pool's outgoing sends to them — read from chain, not from a private
// database. Exactly-once needs no store: a crashed or concurrent sweeper
// re-derives the same numbers and the already-broadcast send is already in
// the pool's history. Failure modes point the safe way: a missing input can
// only UNDERpay (retried next sweep), never double-pay.

import * as nanocurrency from "nanocurrency";
import type { NanoBlock } from "../indexer/blockSource";

export interface Obligation {
  recipient: string;
  amountRaw: bigint;
}

/** Total XNO the pool has already sent to each recipient, from its own chain.
 * (Includes the 1-raw anchor hello — harmless: the anchor has no entitlement.) */
export function poolOutgoingByRecipient(blocks: NanoBlock[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of blocks) {
    if (b.subtype !== "send") continue;
    if (!/^[0-9a-fA-F]{64}$/.test(b.link)) continue;
    const amt = BigInt(b.amount ?? "0");
    if (amt <= 0n) continue;
    const to = nanocurrency.deriveAddress(b.link.toLowerCase(), { useNanoPrefix: true });
    out.set(to, (out.get(to) ?? 0n) + amt);
  }
  return out;
}

/** Per-recipient entitlement for one token: cumulative WITHDRAWN XNO (the
 * replay's xnoWithdrawn — sells accrue in-game credit and only an explicit
 * withdraw op makes it payable; see core/state.ts) + refund owed. Withdrawals
 * and refunds NET together per recipient, which is what makes chain-derived
 * dedupe unambiguous (no per-send classification needed). Era-safe by
 * construction: pre-feature sells replay as credit (withdrawn 0), and any XNO
 * the pool already sent a recipient under the old auto-payout rule counts
 * against their first withdrawal — never a double-pay, never a clawback. */
export function entitlementsFor(
  withdrawn: Map<string, bigint>,
  refunds: Map<string, bigint>
): Map<string, bigint> {
  const ent = new Map<string, bigint>();
  for (const [to, w] of withdrawn) {
    if (w > 0n) ent.set(to, (ent.get(to) ?? 0n) + w);
  }
  for (const [to, owed] of refunds) ent.set(to, (ent.get(to) ?? 0n) + owed);
  return ent;
}

/** Owed deltas, deterministically ordered (by recipient) so every settler
 * builds the identical block sequence — concurrent sweepers converge on the
 * same hashes and duplicates are no-ops at the node. */
export function netObligations(entitled: Map<string, bigint>, sent: Map<string, bigint>): Obligation[] {
  const out: Obligation[] = [];
  for (const [recipient, e] of entitled) {
    const delta = e - (sent.get(recipient) ?? 0n);
    if (delta > 0n) out.push({ recipient, amountRaw: delta });
  }
  return out.sort((a, b) => (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0));
}
