// HoldFun Nano L2 — block sources.
//
// The indexer reads Nano blocks through a `BlockSource`. Two implementations:
// `MemorySource` (tests / local) and `NanoRpcSource` (untrusted RPC endpoints).
//
// NanoRpcSource verifies every returned block LOCALLY: the state-block hash is
// recomputed from its fields and the ed25519-blake2b signature checked against
// the owning account. A lying endpoint can therefore omit blocks (liveness),
// but never forge one (integrity) — which is what makes multi-endpoint
// failover safe. Value-bearing blocks that fail verification are rejected;
// zero-amount blocks that fail only the signature check (epoch blocks are
// signed by the epoch signer, not the account) are kept — they can never be
// ops or deposits, so they cannot influence state.

import * as nanocurrency from "nanocurrency";
import { nanoRpc } from "../lib/rpc";

export interface NanoBlock {
  account: string;
  hash: string;
  previous: string;
  link: string; // 64-hex: the op commitment / destination
  representative: string; // token id (or data carrier)
  height: bigint;
  timestamp?: string;
  amount?: string; // raw amount the block sends (0 for opens/receives)
  subtype?: string; // send | receive | open | change | epoch (when known)
}

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

/** Local verification of a fetched block (see header). Exported for tests. */
export function verifyFetchedBlock(
  hash: string,
  b: { block_account: string; contents: any; amount?: string }
): boolean {
  const c = b.contents ?? {};
  if (c.type && c.type !== "state") {
    // Legacy pre-state blocks predate this app's history; keep only if valueless.
    return !b.amount || BigInt(b.amount) === 0n;
  }
  try {
    const computed = nanocurrency.hashBlock({
      account: c.account ?? b.block_account,
      previous: c.previous,
      representative: c.representative,
      balance: c.balance,
      link: c.link,
    });
    if (computed.toLowerCase() !== hash.toLowerCase()) return false; // tampered contents
    const publicKey = nanocurrency.derivePublicKey(c.account ?? b.block_account);
    const sigOk = (nanocurrency as any).verifyBlock({
      hash: computed,
      signature: String(c.signature ?? "").toUpperCase(),
      publicKey,
    });
    if (sigOk) return true;
    // Epoch blocks are account-chain blocks signed by the epoch signer: keep
    // only when valueless (they can never be ops or deposits).
    return !b.amount || BigInt(b.amount) === 0n;
  } catch {
    return false;
  }
}

/**
 * Reads blocks from untrusted RPC endpoints (lib/rpc.ts failover list) and
 * verifies each block locally. Uses `account_history` + `blocks_info`.
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
        if (!verifyFetchedBlock(hash, b)) continue; // forged/tampered → reject
        blocks.push({
          account: b.block_account,
          hash,
          previous: b.contents?.previous ?? "",
          link: b.contents?.link ?? "",
          representative: b.contents?.representative ?? "",
          height: BigInt(b.height),
          timestamp: b.local_timestamp,
          amount: b.amount,
          subtype: (b as any).subtype ?? b.contents?.subtype,
        });
      }

      const prev = hist.previous;
      if (!prev || /^0+$/.test(prev)) break;
      head = prev;
    }

    return blocks.sort((a, b) => (a.height < b.height ? -1 : 1));
  }
}

