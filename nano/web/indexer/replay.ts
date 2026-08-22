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

/**
 * Deterministic FIXPOINT application order for a multi-token event list.
 *
 * Canonical order sorts by PER-ACCOUNT chain height (multiIndexer.ts), so an
 * op from a young chain can sort before the launch it depends on — a fresh
 * wallet at height 4 buying a token launched at the creator's height 30 would
 * replay "before" the launch and die as invalid, silently eating a real
 * deposit. The fix is a fixpoint: fold the events in canonical order, keep
 * the failures (in order), and re-fold the remainder until a full pass makes
 * no progress. Every replayer runs the identical procedure over the identical
 * ordered list, so the resulting APPLICATION order — and therefore the state —
 * is still byte-identical everywhere. Slippage guards keep any deferred
 * execution inside the bounds its signer already accepted.
 */
export function fixpointOrder<T extends MultiBlock>(events: T[]): {
  applied: T[];
  state: MultiState;
  invalid: { index: number; reason: string }[];
} {
  let state = multiEmpty();
  const applied: T[] = [];
  let pending = events.map((e, i) => ({ e, i }));
  let lastErr = new Map<number, string>();
  for (;;) {
    const still: { e: T; i: number }[] = [];
    const errs = new Map<number, string>();
    for (const p of pending) {
      try {
        state = applyBlock(state, p.e);
        applied.push(p.e);
      } catch (err) {
        errs.set(p.i, err instanceof Error ? err.message : String(err));
        still.push(p);
      }
    }
    lastErr = errs;
    if (still.length === pending.length || still.length === 0) {
      pending = still;
      break;
    }
    pending = still;
  }
  const invalid = pending.map((p) => ({ index: p.i, reason: lastErr.get(p.i) ?? "invalid" }));
  return { applied, state, invalid };
}

/** Multi-token fold: each block carries its tokenId and routes to that token. */
export function replayMulti(events: MultiBlock[]): { state: MultiState; invalid: { index: number; reason: string }[] } {
  const { state, invalid } = fixpointOrder(events);
  return { state, invalid };
}
