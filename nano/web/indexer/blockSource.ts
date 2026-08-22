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
import { nanoRpc, FALLBACK_RPC } from "../lib/rpc";
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

/** Pending list straight from the FALLBACK endpoint (keyless, per the strict
 * RPC rule — the key is never sent there). Used only to widen the pending
 * union in counterparties(); results are locally verified downstream. */
async function fallbackPending(account: string): Promise<string[]> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    const res = await fetch(FALLBACK_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pending", account, count: 1000 }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j = (await res.json()) as any;
    return Array.isArray(j?.blocks) ? (j.blocks as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reads blocks from rpc.nano.to (nano-gpt fallback) and verifies each block
 * locally (core/blockVerify.ts). Uses `account_history` + `blocks_info`, with a
 * frontier-keyed cache so unchanged accounts are skipped.
 */
export class NanoRpcSource implements BlockSource, CounterpartyReader {
  constructor(private apiKey: string) {}

  /**
   * blocks_info with RETRIES for silently-omitted entries. Root-caused live
   * (2026-08-22): rpc.nano.to's batch blocks_info randomly OMITS some of the
   * requested hashes depending on which backend node answers — the same
   * request, seconds apart, resolves a different subset. A dropped entry made
   * discovery silently lose a real hello sender (a freshly-launched coin's
   * creator vanished from the index) and could leave a gap mid-chain in
   * listBlocks. Each retry very likely lands on a different backend, so up to
   * 3 attempts converge on the full set; anything still missing after that is
   * genuinely unknown to both endpoints and is returned unresolved.
   */
  private async fetchBlocksInfo(apiKey: string, hashes: string[]): Promise<Map<string, any>> {
    const infos = new Map<string, any>();
    let missing = hashes;
    for (let attempt = 0; attempt < 3 && missing.length > 0; attempt++) {
      const next: string[] = [];
      for (let i = 0; i < missing.length; i += 200) {
        const chunk = missing.slice(i, i + 200);
        const info = (await nanoRpc(apiKey, { action: "blocks_info", hashes: chunk, json_block: true }).catch(() => ({}))) as any;
        for (const h of chunk) {
          const b = info.blocks?.[h];
          if (b?.block_account) infos.set(h, b);
          else next.push(h);
        }
      }
      missing = next;
    }
    return infos;
  }

  /** Discovery primitive: who sent into / received from this account. Inbound
   * covers both confirmed receives and STILL-PENDING sends (a hello counts
   * even if the anchor never pockets it).
   *
   * The pending list is unioned across ALL THREE permitted views of the two
   * allowed endpoints — nano.to keyed, nano.to keyless, and the nano-gpt
   * fallback. Root-caused live (2026-08-22): pending/receivable state is
   * node-local in Nano, and rpc.nano.to's regional backends serve DIFFERENT
   * pending lists for the same account (its US cluster was missing a
   * confirmed hello for hours that both its EU view and nano-gpt had), so a
   * new creator's coin never appeared for requests served from that region.
   * Unioning is safe: every hash is then resolved via blocks_info and
   * verified locally (core/blockVerify.ts), so a wrong entry cannot get in —
   * omission was the only failure mode, and a union closes it as long as ANY
   * of the three views has current data. No new endpoints (strict RPC rule):
   * the key still goes only to nano.to, never to the fallback. */
  async counterparties(account: string): Promise<{ inbound: HelloInfo[]; outbound: string[] }> {
    const blocks = await this.listBlocks(account);
    const sourceHashes = blocks
      .filter((b) => (b.subtype === "receive" || b.subtype === "open") && /^[0-9a-fA-F]{64}$/.test(b.link))
      .map((b) => b.link);
    const [pKeyed, pKeyless, pFallback] = await Promise.all([
      nanoRpc(this.apiKey, { action: "pending", account, count: 1000 }).catch(() => ({})),
      nanoRpc("", { action: "pending", account, count: 1000 }).catch(() => ({})),
      fallbackPending(account),
    ]);
    const pending = [
      ...(((pKeyed as any).blocks ?? []) as string[]),
      ...(((pKeyless as any).blocks ?? []) as string[]),
      ...pFallback,
    ];
    const all = [...new Set([...sourceHashes, ...pending])];

    const inbound: HelloInfo[] = [];
    for (const [h, b] of await this.fetchBlocksInfo(this.apiKey, all)) {
      if (!verifyFetchedBlock(h, b)) continue; // never trust unverified senders
      inbound.push({ sender: b.block_account, representative: b.contents?.representative ?? "" });
    }
    const outbound = blocks
      .filter((b) => b.subtype === "send" && /^[0-9a-fA-F]{64}$/.test(b.link))
      .map((b) => nanocurrency.deriveAddress(b.link, { useNanoPrefix: true }));
    return { inbound, outbound };
  }

  /**
   * Root-caused live (2026-08-22): the exact same account, queried at the
   * exact same moment, can report a DIFFERENT frontier from rpc.nano.to's
   * keyed tier vs its own keyless tier — the keyed tier lagged behind on a
   * specific account's history, silently hiding its most recent blocks (a
   * launch, in the observed case). Cheap fix: check both frontiers first (one
   * lightweight account_info each, in parallel). If they agree, the keyed
   * tier is caught up and the normal single-source walk below is used as
   * before. If they disagree, walk BOTH full chains and keep whichever is
   * more complete — blocks are self-verifying (core/blockVerify.ts), so a
   * longer verified chain is strictly a superset of a shorter one from the
   * same real ledger, never a reason to distrust it. The common case (tiers
   * agree) pays only one extra cheap call; the full double-walk only
   * triggers when staleness is actually detected.
   */
  async listBlocks(account: string, limit = 20000): Promise<NanoBlock[]> {
    const [keyedFrontier, keylessFrontier] = await Promise.all([
      nanoRpc(this.apiKey, { action: "account_info", account }).then((i: any) => String(i?.frontier ?? "")).catch(() => ""),
      nanoRpc("", { action: "account_info", account }).then((i: any) => String(i?.frontier ?? "")).catch(() => ""),
    ]);

    // A walk is COMPLETE only when the verified chain actually contains the
    // frontier its own tier reported. Root-caused live (2026-08-22, part 3 of
    // the stale-backend saga): a backend can answer account_info with the
    // fresh frontier while its account_history is still hours behind — the
    // walk "succeeds" with an old, shorter chain (a creator's just-submitted
    // liquidity seed was silently missing), and before this check that stale
    // chain was CACHED under the fresh frontier key, poisoning the instance
    // until restart. Now: up to two rounds across both tiers, prefer any
    // complete walk (longest); only fall back to the longest incomplete walk
    // when no round produced a complete one, and never cache incomplete.
    const attempt = async (): Promise<{ blocks: NanoBlock[]; complete: boolean }[]> => {
      const settled = await Promise.allSettled([
        this.fetchChain(this.apiKey, account, limit, keyedFrontier),
        this.fetchChain("", account, limit, keylessFrontier),
      ]);
      return settled
        .filter((r): r is PromiseFulfilledResult<{ blocks: NanoBlock[]; complete: boolean }> => r.status === "fulfilled")
        .map((r) => r.value);
    };

    let best: { blocks: NanoBlock[]; complete: boolean } | null = null;
    for (let round = 0; round < 2; round++) {
      for (const r of await attempt()) {
        if (best === null) { best = r; continue; }
        const better = (r.complete && !best.complete) || (r.complete === best.complete && r.blocks.length > best.blocks.length);
        if (better) best = r;
      }
      if (best !== null && best.complete) return best.blocks;
    }
    if (best === null) throw new Error(`listBlocks(${account}): both keyed and keyless RPC failed`);
    return best.blocks;
  }

  private async fetchChain(apiKey: string, account: string, limit: number, frontier: string): Promise<{ blocks: NanoBlock[]; complete: boolean }> {
    // H2 fast path: if the account's frontier is unchanged, its verified block
    // list is unchanged — skip the whole history pull. Only COMPLETE chains
    // are ever cached (see below), so a hit is always frontier-consistent.
    if (frontier) {
      const hit = FRONTIER_CACHE.get(`${account}|${frontier}`);
      if (hit) return { blocks: hit, complete: true };
    }

    const raw: RawFetchedBlock[] = [];
    const seen = new Set<string>();
    let head: string | undefined;

    while (raw.length < limit) {
      const params: Record<string, unknown> = { action: "account_history", account, count: 500, raw: true };
      if (head) params.head = head;
      const hist = (await nanoRpc(apiKey, params)) as {
        history?: { hash: string; height: string }[];
        previous?: string;
      };
      const history = hist.history ?? [];
      if (history.length === 0) break;
      const hashes = history.map((h) => h.hash).filter((h) => !seen.has(h));
      if (hashes.length === 0) break;

      const infos = await this.fetchBlocksInfo(apiKey, hashes);
      for (const hash of hashes) {
        const b = infos.get(hash);
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
    // Complete = the verified chain reaches the frontier this tier reported.
    // An account_history served by a lagging backend can be SHORTER than the
    // frontier implies even in the same request — that chain is real but
    // stale, must never be cached, and callers should prefer a complete walk.
    const complete = !frontier || out.some((b) => b.hash === frontier);
    // Cache only complete, un-truncated chains (a truncated pull at `limit`
    // must not be cached as the whole history either).
    if (frontier && complete && raw.length < limit) {
      if (FRONTIER_CACHE.size >= FRONTIER_CACHE_MAX) FRONTIER_CACHE.delete(FRONTIER_CACHE.keys().next().value!);
      FRONTIER_CACHE.set(`${account}|${frontier}`, out);
    }
    return { blocks: out, complete };
  }
}

