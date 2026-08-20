// HoldFun Nano L2 — block sources.
//
// The indexer reads Nano blocks through a `BlockSource`. Two implementations:
// `MemorySource` (tests / local) and `NanoRpcSource` (rpc.nano.to).

import { NANO_RPC, nanoRpc } from "../lib/rpc";

export interface NanoBlock {
  account: string;
  hash: string;
  previous: string;
  link: string; // 64-hex: the op commitment
  representative: string; // token id (or data carrier)
  height: bigint;
  timestamp?: string;
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

  async listBlocks(account: string, limit = 100): Promise<NanoBlock[]> {
    const hist = (await nanoRpc(this.apiKey, {
      action: "account_history",
      account,
      count: limit,
      raw: true,
    })) as { history?: { hash: string; height: string }[] };

    const hashes = (hist.history ?? []).map((h) => h.hash);
    if (hashes.length === 0) return [];

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
        }
      >;
    };

    return hashes
      .map((hash) => {
        const b = info.blocks?.[hash];
        if (!b) return null;
        return {
          account: b.block_account,
          hash,
          previous: b.contents?.previous ?? "",
          link: b.contents?.link ?? "",
          representative: b.contents?.representative ?? "",
          height: BigInt(b.height),
          timestamp: b.local_timestamp,
        } satisfies NanoBlock;
      })
      .filter((b): b is NanoBlock => b !== null)
      .sort((a, b) => (a.height < b.height ? -1 : 1));
  }
}

