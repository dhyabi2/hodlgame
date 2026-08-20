// HoldFun Nano L2 — block sources.
//
// The indexer reads Nano blocks through a `BlockSource`. Two implementations:
// `MemorySource` (tests / local) and `NanoRpcSource` (rpc.nano.to).

import { NANO_RPC, nanoRpc } from "../lib/rpc";

export interface NanoBlock {
  account: string;
  hash: string;
  previous: string;
  link: string; // 64-hex: the op commitment / destination
  representative: string; // token id (or data carrier)
  height: bigint;
  timestamp?: string;
  amount?: string; // raw amount the block sends (0 for opens/receives)
}

export interface BlockSource {
  /** Recent blocks for an account, oldest first. */
  listBlocks(account: string, limit?: number): Promise<NanoBlock[]>;
}

/** In-memory source for tests and local replay. */
export class MemorySource implements BlockSource {
  private blocks: NanoBlock[] = [];
  push(b: NanoBlock) {
    this.blocks.push(b);
  }
  async listBlocks(account: string): Promise<NanoBlock[]> {
    return this.blocks
      .filter((b) => b.account === account)
      .sort((a, b) => (a.height < b.height ? -1 : 1));
  }
}

/**
 * Reads blocks from rpc.nano.to (strict — no other nodes). Uses
 * `account_history` + `blocks_info`.
 */
export class NanoRpcSource implements BlockSource {
  constructor(private apiKey: string) {}

  async listBlocks(account: string, limit = 20000): Promise<NanoBlock[]> {
    const blocks: NanoBlock[] = [];
    const seen = new Set<string>();
    let head: string | undefined;

    while (blocks.length < limit) {
      const params: Record<string, unknown> = { action: "account_history", account, count: 500, raw: true };
      if (head) params.head = head;
      const hist = (await nanoRpc(this.apiKey, params)) as {
        history?: { hash: string; height: string }[];
        previous?: string;
      };
      const history = hist.history ?? [];
      if (history.length === 0) break;
      const hashes = history.map((h) => h.hash).filter((h) => !seen.has(h));
      if (hashes.length === 0) break;

      const info = (await nanoRpc(this.apiKey, {
        action: "blocks_info",
        hashes,
        json_block: true,
      })) as {
        blocks?: Record<
          string,
          {
            block_account: string;
            contents: any;
            height: string;
            local_timestamp?: string;
            amount?: string;
          }
        >;
      };

      for (const hash of hashes) {
        const b = info.blocks?.[hash];
        if (!b) continue;
        seen.add(hash);
        blocks.push({
          account: b.block_account,
          hash,
          previous: b.contents?.previous ?? "",
          link: b.contents?.link ?? "",
          representative: b.contents?.representative ?? "",
          height: BigInt(b.height),
          timestamp: b.local_timestamp,
          amount: b.amount,
        });
      }

      const prev = hist.previous;
      if (!prev || /^0+$/.test(prev)) break;
      head = prev;
    }

    return blocks.sort((a, b) => (a.height < b.height ? -1 : 1));
  }
}

