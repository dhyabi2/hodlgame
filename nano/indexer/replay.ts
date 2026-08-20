// HoldFun Nano L2 — replay engine.
//
// Given an ordered list of (sender, op, height), fold them into the token state.
// Invalid ops are flagged (not thrown), so the indexer can still serve the
// canonical state of everything that came before the bad block.

import { applyOp, emptyState, type State } from "../core/state";
import { applyBlock, multiEmpty, type MultiState, type MultiBlock } from "../core/multi";
import type { Op } from "../core/ops";

export interface ReplayEvent {
  sender: string;
  op: Op;
  height: bigint;
}

export interface ReplayResult {
  state: State;
  invalid: { index: number; reason: string }[];
}

export function replay(events: ReplayEvent[]): ReplayResult {
  let state = emptyState();
  const invalid: ReplayResult["invalid"] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    try {
      state = applyOp(state, e.op, e.sender, e.height);
    } catch (err) {
      invalid.push({
        index: i,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { state, invalid };
}

/** Multi-token fold: each block carries its tokenId and routes to that token. */
export function replayMulti(events: MultiBlock[]): { state: MultiState; invalid: { index: number; reason: string }[] } {
  let state = multiEmpty();
  const invalid: { index: number; reason: string }[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    try {
      state = applyBlock(state, e);
    } catch (err) {
      invalid.push({
        index: i,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { state, invalid };
}
