// HoldFun Nano L2 — indexer.
//
// Glues a BlockSource (Nano blocks) to the deterministic state machine. The
// resolver maps a block's `link` commitment back to the full op — for the spike
// it's a caller-provided map; production indexers build it from the on-chain
// commitment + off-chain payloads (commit-reveal, see SPEC.md §2).

import { emptyState, type State } from "../core/state";
import type { Op } from "../core/ops";
import { opCommitment } from "../core/encoding";
import { replay } from "./replay";
import type { BlockSource, NanoBlock } from "./blockSource";

export type OpResolver = (block: NanoBlock) => Op | null;

/** Resolve ops from an in-memory commitment → op map (for tests / local). */
export function mapResolver(map: Map<string, Op>): OpResolver {
  return (block) => map.get(block.link) ?? null;
}

export class Indexer {
  private state: State = emptyState();

  constructor(private source: BlockSource, private resolveOp: OpResolver) {}

  getState(): State {
    return this.state;
  }

  /** Pull blocks for a set of accounts and fold them into state. */
  async sync(accounts: string[]): Promise<{ applied: number; invalid: number }> {
    const events: { sender: string; op: Op; height: bigint }[] = [];
    for (const account of accounts) {
      const blocks = await this.source.listBlocks(account);
      for (const block of blocks) {
        const op = this.resolveOp(block);
        if (op) {
          // Verify the commitment matches the resolved op (commit-reveal).
          if (opCommitment(op) !== block.link) continue; // mismatch → skip
          events.push({ sender: block.account, op, height: block.height });
        }
      }
    }
    events.sort((a, b) => (a.height < b.height ? -1 : 1));
    const result = replay(events);
    this.state = result.state;
    return { applied: events.length - result.invalid.length, invalid: result.invalid.length };
  }
}