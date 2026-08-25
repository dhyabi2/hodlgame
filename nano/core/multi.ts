// Multi-token state router. Keeps one deterministic `State` per token, keyed by
// its TokenId. Pure: no network, no timestamps — two indexers folding the same
// blocks into the same map produce byte-identical results.

import { applyOp, applyVoid, emptyState, type State } from "./state";
import type { Op } from "./ops";
import type { TokenId } from "./token";

export type MultiState = Map<TokenId, State>;

export interface MultiBlock {
  tokenId: TokenId;
  op: Op;
  sender: string;
  height: bigint;
  /** Carrier block's network-observed time (seconds). Consensus input only
   * for era-gated rules (state.ts FULL_REBATE_ERA); absent → legacy. */
  timestamp?: number;
}

export function multiEmpty(): MultiState {
  return new Map();
}

export function tokenState(m: MultiState, tokenId: TokenId): State {
  return m.get(tokenId) ?? emptyState();
}

/** Fold a signed balance observation across ALL direct tokens. One account's
 * real balance may back earmarks in several tokens — the requirement is the
 * SUM of its ratcheted floors. If the observed balance falls below that sum,
 * each token's position is voided proportionally (deterministic floor
 * division), so one XNO can never double-count as collateral in two games. */
function applyBalanceObservation(m: MultiState, account: string, raw: bigint): MultiState {
  let total = 0n;
  const floors: { tokenId: TokenId; floor: bigint }[] = [];
  for (const [tokenId, s] of m) {
    if (!s.direct) continue;
    const f = s.earmarkFloor.get(account) ?? 0n;
    if (f > 0n) {
      total += f;
      floors.push({ tokenId, floor: f });
    }
  }
  if (total <= 0n || raw >= total) return m;
  const out = new Map(m);
  for (const { tokenId, floor } of floors) {
    const newFloor = (floor * raw) / total; // prorate the observed balance
    const next = applyVoid(out.get(tokenId)!, account, newFloor);
    out.set(tokenId, next);
  }
  return out;
}

/** Apply one op to the token's own state (launching it on first use). */
export function applyBlock(m: MultiState, b: MultiBlock): MultiState {
  if (b.op.kind === "balance") return applyBalanceObservation(m, b.sender, b.op.raw);
  const next = applyOp(tokenState(m, b.tokenId), b.op, b.sender, b.height, b.timestamp);
  next.id = b.tokenId;
  const out = new Map(m);
  out.set(b.tokenId, next);
  return out;
}

export function applyBlocks(m: MultiState, blocks: MultiBlock[]): MultiState {
  let s = m;
  for (const b of blocks) s = applyBlock(s, b);
  return s;
}

/** All launched tokens (id + state), in insertion order. */
export function tokens(m: MultiState): { tokenId: TokenId; state: State }[] {
  const out: { tokenId: TokenId; state: State }[] = [];
  for (const [tokenId, state] of m) if (state.launched) out.push({ tokenId, state });
  return out;
}
