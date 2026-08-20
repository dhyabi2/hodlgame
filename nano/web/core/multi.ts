// Multi-token state router. Keeps one deterministic `State` per token, keyed by
// its TokenId. Pure: no network, no timestamps — two indexers folding the same
// blocks into the same map produce byte-identical results.

import { applyOp, emptyState, type State } from "./state";
import type { Op } from "./ops";
import type { TokenId } from "./token";

export type MultiState = Map<TokenId, State>;

export interface MultiBlock {
  tokenId: TokenId;
  op: Op;
  sender: string;
  height: bigint;
}

export function multiEmpty(): MultiState {
  return new Map();
}

export function tokenState(m: MultiState, tokenId: TokenId): State {
  return m.get(tokenId) ?? emptyState();
}

/** Apply one op to the token's own state (launching it on first use). */
export function applyBlock(m: MultiState, b: MultiBlock): MultiState {
  const next = applyOp(tokenState(m, b.tokenId), b.op, b.sender, b.height);
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
