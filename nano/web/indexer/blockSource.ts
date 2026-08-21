// HoldFun Nano L2 — block sources.
//
// The indexer reads Nano blocks through a `BlockSource`. Two implementations:
// `MemorySource` (tests / local) and `NanoRpcSource` (untrusted RPC endpoints).
//
// NanoRpcSource verifies every returned block LOCALLY (core/blockVerify.ts):
// the hash is recomputed from the signed fields, the signature checked against
// the account the node attributes it to (binding closes owner-forgery), and
// amount/subtype are DERIVED from the signed balance chain — the node's
// unsigned amount/subtype are never trusted. A lying endpoint can omit blocks
// (liveness) but cannot forge value, ownership, or attribution (integrity).

import * as nanocurrency from "nanocurrency";
import { nanoRpc } from "../lib/rpc";
import { verifyFetchedBlock, deriveAmountSubtype, finalizeChain, type NanoBlock, type RawFetchedBlock } from "../core/blockVerify";

// Re-export the browser-safe verification primitives (single source of truth,
// also used by the in-browser verifier).
export { verifyFetchedBlock, deriveAmountSubtype, finalizeChain, type NanoBlock, type RawFetchedBlock };

export interface BlockSource {
  /** Recent blocks for an account, oldest first. */
  listBlocks(account: string, limit?: number): Promise<NanoBlock[]>;
}

/** Who transacted with an account — the discovery primitive (core/anchor.ts). */
export interface HelloInfo {
  sender: string;
  representative: string; // the SENDER's block representative (pool hellos encode tokenId here)
}
export interface CounterpartyReader {
  /** Senders into `account` (confirmed receives + still-pending sends, with
   * each send block's representative) and recipients of `account`'s sends. */
  counterparties(account: string): Promise<{ inbound: HelloInfo[]; outbound: string[] }>;
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

// Frontier-keyed block cache (explorer H2 / incremental indexing). An account's
// verified block list is a pure function of its chain, so it changes only when
// its frontier moves. Caching by (account, frontier) lets a sync skip the full
// history pull for every unchanged account — steady-state cost becomes
// O(changed accounts), not O(world) — with ZERO effect on determinism (a moved
// frontier is a fresh key → refetch). Module-level so it survives across the
// per-request MultiIndexer instances within one serverless instance.
const FRONTIER_CACHE = new Map<string, NanoBlock[]>(); // `${account}|${frontier}` → blocks
const FRONTIER_CACHE_MAX = 5000;

/**
 * Reads blocks from rpc.nano.to (nano-gpt fallback) and verifies each block
 * locally (core/blockVerify.ts). Uses `account_history` + `blocks_info`, with a
 * frontier-keyed cache so unchanged accounts are skipped.
 */
export class NanoRpcSource implements BlockSource, CounterpartyReader {
  constructor(private apiKey: string) {}

  /** Discovery primitive: who sent into / received from this account. Inbound
   * covers both confirmed receives and STILL-PENDING sends (a hello counts
   * even if the anchor never pockets it). */
  async counterparties(account: string): Promise<{ inbound: HelloInfo[]; outbound: string[] }> {
    const blocks = await this.listBlocks(account);
    const sourceHashes = blocks
      .filter((b) => (b.subtype === "receive" || b.subtype === "open") && /^[0-9a-fA-F]{64}$/.test(b.link))
      .map((b) => b.link);
    const pend = await nanoRpc(this.apiKey, { action: "pending", account, count: 1000 }).catch(() => ({}));
    const pending = ((pend as any).blocks ?? []) as string[];
    const all = [...new Set([...sourceHashes, ...pending])];

    const inbound: HelloInfo[] = [];
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      const info = (await nanoRpc(this.apiKey, { action: "blocks_info", hashes: chunk, json_block: true })) as any;
      for (const h of chunk) {
        const b = info.blocks?.[h];
        if (!b?.block_account) continue;
        if (!verifyFetchedBlock(h, b)) continue; // never trust unverified senders
        inbound.push({ sender: b.block_account, representative: b.contents?.representative ?? "" });
      }
    }
    const outbound = blocks
      .filter((b) => b.subtype === "send" && /^[0-9a-fA-F]{64}$/.test(b.link))
      .map((b) => nanocurrency.deriveAddress(b.link, { useNanoPrefix: true }));
    return { inbound, outbound };
  }

  async listBlocks(account: string, limit = 20000): Promise<NanoBlock[]> {
    // H2 fast path: if the account's frontier is unchanged, its verified block
    // list is unchanged. One cheap account_info avoids the whole history pull.
    const frontier = await nanoRpc(this.apiKey, { action: "account_info", account })
      .then((i: any) => String(i?.frontier ?? ""))
      .catch(() => "");
    if (frontier) {
      const hit = FRONTIER_CACHE.get(`${account}|${frontier}`);
      if (hit) return hit;
    }

    const raw: RawFetchedBlock[] = [];
    const seen = new Set<string>();
    let head: string | undefined;

    while (raw.length < limit) {
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
      })) as { blocks?: Record<string, { block_account: string; contents: any; height: string; local_timestamp?: string }> };

      for (const hash of hashes) {
        const b = info.blocks?.[hash];
        if (!b) continue;
        seen.add(hash);
        raw.push({ hash, block_account: b.block_account, contents: b.contents, height: b.height, local_timestamp: b.local_timestamp });
      }

      const prev = hist.previous;
      if (!prev || /^0+$/.test(prev)) break;
      head = prev;
    }

    // Sort + verify + derive amount/subtype from signed balances (shared logic).
    const out = finalizeChain(raw);
    // Cache under the frontier we observed (only if the whole chain fit —
    // a truncated pull at `limit` must not be cached as complete).
    if (frontier && raw.length < limit) {
      if (FRONTIER_CACHE.size >= FRONTIER_CACHE_MAX) FRONTIER_CACHE.delete(FRONTIER_CACHE.keys().next().value!);
      FRONTIER_CACHE.set(`${account}|${frontier}`, out);
    }
    return out;
  }
}

