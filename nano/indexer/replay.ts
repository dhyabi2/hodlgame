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
export function fixpointOrder<T extends MultiBlock>(
  events: T[],
  // Called after each successful apply with the states around it — lets a
  // consumer (explorer deltas) observe the SAME application order and
  // validity as consensus, instead of re-deriving them with a divergent fold.
  onApply?: (e: T, before: MultiState, after: MultiState) => void
): {
  applied: T[];
  state: MultiState;
  invalid: { index: number; reason: string }[];
} {
  let state = multiEmpty();
  const applied: T[] = [];
  const deferred: { e: T; i: number }[] = [];
  const errs = new Map<number, string>();
  const tryApply = (p: { e: T; i: number }): boolean => {
    const before = state;
    try {
      state = applyBlock(state, p.e);
      applied.push(p.e);
      errs.delete(p.i);
      onApply?.(p.e, before, state);
      return true;
    } catch (err) {
      errs.set(p.i, err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  // STABILITY (not just determinism): a deferred op is retried IMMEDIATELY
  // after every successful apply, so it anchors to the EARLIEST point where
  // it becomes valid. A pass-based fixpoint is deterministic too, but a block
  // arriving later in canonical order could jump ahead of an earlier deferred
  // one and retroactively re-price already-observed history. With
  // earliest-unlock anchoring, APPENDING later events can never change where
  // an earlier event applied — history stays stable as the chain grows.
  // (Stability additionally requires that newly discovered blocks actually
  // SORT after existing history. Lamport-only ordering violated that — a
  // fresh externally-funded wallet's whole chain carried near-zero clocks and
  // inserted before old events, re-pricing them until their own slippage
  // guards invalidated them. canonicalOrder now sorts by the block's
  // network-observed timestamp first, so new activity is new, not earlier.)
  const drainDeferred = () => {
    let progress = true;
    while (progress) {
      progress = false;
      for (let j = 0; j < deferred.length; ) {
        if (tryApply(deferred[j])) {
          deferred.splice(j, 1);
          progress = true;
        } else j++;
      }
    }
  };
  for (let i = 0; i < events.length; i++) {
    const p = { e: events[i], i };
    if (tryApply(p)) drainDeferred();
    else deferred.push(p);
  }
  const invalid = deferred.map((p) => ({ index: p.i, reason: errs.get(p.i) ?? "invalid" }));
  return { applied, state, invalid };
}

/** Multi-token fold: each block carries its tokenId and routes to that token. */
export function replayMulti(events: MultiBlock[]): { state: MultiState; invalid: { index: number; reason: string }[] } {
  const { state, invalid } = fixpointOrder(events);
  return { state, invalid };
}
