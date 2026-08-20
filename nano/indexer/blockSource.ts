// HoldFun Nano L2 — block sources.
//
// The indexer reads Nano blocks through a `BlockSource`. Two implementations:
// `MemorySource` (tests / local) and `NanoRpcSource` (a real Nano node via RPC).

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
 * Reads blocks from a Nano node's JSON-RPC API (e.g. `https://rpc.nano.to`).
 * Uses `account_history` + `blocks_info` — both are read-only and work on
 * public nodes.
 */
export class NanoRpcSource implements BlockSource {
  constructor(private endpoint: string) {}

  private async rpc(body: Record<string, unknown>) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`nano rpc ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    if (json.error) throw new Error(String(json.error));
    return json;
  }

  async listBlocks(account: string, limit = 100): Promise<NanoBlock[]> {
    const hist = (await this.rpc({
      action: "account_history",
      account,
      count: limit,
      raw: true,
    })) as { history?: { hash: string; height: string }[] };

    const hashes = (hist.history ?? []).map((h) => h.hash);
    if (hashes.length === 0) return [];

    const info = (await this.rpc({
      action: "blocks_info",
      hashes,
      json_block: true,
    })) as { blocks?: Record<string, { block_account: string; contents: any; height: string; local_timestamp?: string }> };

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
