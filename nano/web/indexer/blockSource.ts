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

type RpcCall = (body: Record<string, unknown>) => Promise<any>;

/** Direct call to the FALLBACK endpoint (keyless, per the strict RPC rule —
 * the key is never sent there). nanoRpc only falls over on TRANSPORT failure,
 * but a stale-yet-responsive primary needs its answers CROSS-CHECKED, so
 * discovery and frontier selection query the fallback explicitly and union /
 * maximize over all views. Results are always locally verified downstream. */
async function fallbackRpc(body: Record<string, unknown>): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(FALLBACK_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
      // Same cache-buster as lib/rpc.ts callEndpoint — identical POST bodies
      // were served frozen from some regions; a nonce defeats any edge cache.
      body: JSON.stringify({ ...body, _nb: Date.now().toString(36) + Math.random().toString(36).slice(2, 10) }),
      signal: ctl.signal,
    });
    return (await res.json()) as any;
  } finally {
    clearTimeout(t);
  }
}

async function fallbackPending(account: string): Promise<string[]> {
  try {
    const j = await fallbackRpc({ action: "pending", account, count: 1000 });
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
/**
 * Optional SHARED, cross-instance cache (server-only — injected by the server;
 * the browser verifier passes none). Two things, both keyed monotonically so
 * they can only ever move FORWARD and are therefore self-invalidating and safe:
 *  - a per-account monotonic best frontier (never regresses → the target tip is
 *    the freshest EVER observed, so a lagging RPC view can't drag the account
 *    back to an older state → holder counts / poolXno stop flickering);
 *  - the verified block list at that frontier (fetch-once, serve-consistently —
 *    turns flaky per-request RPC into a stable snapshot every instance shares).
 * All methods are best-effort; a store error just falls back to live RPC.
 */
export interface SharedBlockCache {
  getFrontier(account: string): Promise<{ frontier: string; height: number } | null>;
  putFrontier(account: string, frontier: string, height: number): Promise<void>;
  getBlocks(account: string, frontier: string): Promise<NanoBlock[] | null>;
  putBlocks(account: string, frontier: string, blocks: NanoBlock[]): Promise<void>;
}

export class NanoRpcSource implements BlockSource, CounterpartyReader {
  /**
   * `opts.staleTips` lets a READ path serve an account's last known tip from
   * the shared store instead of paying the 3-view probe, when the cheap batch
   * refresh could not resolve it. Off by default, and deliberately never
   * enabled for the payout sweep: money must not move on a stale view.
   */
  constructor(
    private apiKey: string,
    private cache?: SharedBlockCache,
    private opts: { staleTips?: boolean } = {}
  ) {}

  /** When the batched tip refresh last resolved ANYTHING. If it is working,
   * an account it did not resolve is genuinely unopened rather than hidden by
   * rate limiting — which is what makes a stored tip safe to lean on. */
  private lastBatchOkAt = 0;
  /** Accounts served from a stored tip this request — surfaced for observability. */
  readonly tipsFromCache = new Set<string>();

  // account → the exact tip (last block hash) this source replayed for it.
  // Published by the trust view so a browser can pin its own walk to the SAME
  // per-account frontier and reproduce a byte-identical root regardless of any
  // blocks that landed after this snapshot (kills the live-freshness mismatch).
  readonly frontiers = new Map<string, string>();

  // Request-scoped memo. A NanoRpcSource is created fresh per request (compute()
  // makes a new one each call), so this dedupes listBlocks WITHIN one request —
  // not across requests. compute() calls collectEvents up to twice (watched,
  // then watched+extra after the discovery pass), and the discovery pass queries
  // pools; without this, every watched account's uncached best-view frontier
  // check (3 account_info calls) runs twice. This is "compute once per request,"
  // fully debuggable: the memo dies with the instance, so every new request
  // still replays live from chain — there is no stale cross-request cache.
  private blockMemo = new Map<string, Promise<NanoBlock[]>>();
  // Request-scoped best-frontier hints (account → frontier hash), populated by
  // warmFrontiers via ONE batch call per source instead of 3 account_info per
  // account. Also request-scoped (dies with the instance).
  private frontierHint = new Map<string, string>();

  /**
   * Prefetch the best frontier for MANY accounts in ~3 RPC calls instead of
   * 3 per account. Uses the batch `accounts_frontiers` action from all three
   * permitted views; when they AGREE (the common case) the frontier is settled
   * cheaply, and only accounts whose views DISAGREE fall back to the precise
   * per-account best-view (which needs block heights to pick the furthest tip).
   * Preserves the exact freshness guarantee — max observed frontier wins — while
   * collapsing the per-request account_info storm. Degrades gracefully: any
   * account left unhinted just takes the original per-account path in listBlocks,
   * so an endpoint that doesn't support accounts_frontiers changes nothing but
   * speed. Call before collectChains; safe to call repeatedly (skips hinted).
   */
  /** The batch-resolved tips from `warmFrontiers` (account → frontier hash).
   * Exposed so a caller can fingerprint "what the chain looks like right now"
   * in ~1 RPC call, without walking any chain. An account missing from the map
   * is simply unresolved — callers must treat that as "unknown", never "empty".
   */
  frontierHints(): Map<string, string> {
    return new Map(this.frontierHint);
  }

  async warmFrontiers(accounts: string[]): Promise<void> {
    const need = accounts.filter((a) => !this.frontierHint.has(a));
    if (need.length === 0) return;
    const af = async (call: RpcCall): Promise<Record<string, string>> => {
      try {
        // Per-source cap: a slow/rate-limited view resolves to "no data" fast
        // rather than dragging the batch out (unhinted accounts just fall back).
        const j = await Promise.race([
          call({ action: "accounts_frontiers", accounts: need }),
          new Promise<null>((r) => setTimeout(() => r(null), 3000)),
        ]);
        return j && typeof j.frontiers === "object" && j.frontiers ? j.frontiers : {};
      } catch { return {}; }
    };
    const [f0, f1, f2] = await Promise.all([
      af((b) => nanoRpc(this.apiKey, b)),
      af((b) => nanoRpc("", b)),
      af((b) => fallbackRpc(b)),
    ]);
    const disagree: string[] = [];
    for (const account of need) {
      const hs = [f0[account], f1[account], f2[account]].filter((h) => typeof h === "string" && /^[0-9a-fA-F]{64}$/.test(h));
      if (hs.length === 0) continue; // unopened/unknown everywhere → leave unhinted
      if (new Set(hs.map((h) => h.toUpperCase())).size === 1) { this.frontierHint.set(account, hs[0]); this.lastBatchOkAt = Date.now(); }
      else disagree.push(account); // views differ → resolve precisely by height
    }
    await Promise.all(disagree.map(async (account) => {
      const view = async (fn: () => Promise<any>) => {
        try { const i = await fn(); return { frontier: String(i?.frontier ?? ""), height: Number(i?.block_count ?? 0) }; }
        catch { return { frontier: "", height: 0 }; }
      };
      const views = await Promise.all([
        view(() => nanoRpc(this.apiKey, { action: "account_info", account })),
        view(() => nanoRpc("", { action: "account_info", account })),
        view(() => fallbackRpc({ action: "account_info", account })),
      ]);
      const best = views.reduce((a, b) => (b.height > a.height ? b : a));
      if (best.frontier) this.frontierHint.set(account, best.frontier);
    }));
  }

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
  private async fetchBlocksInfo(call: RpcCall, hashes: string[]): Promise<Map<string, any>> {
    const infos = new Map<string, any>();
    let missing = hashes;
    for (let attempt = 0; attempt < 3 && missing.length > 0; attempt++) {
      const next: string[] = [];
      for (let i = 0; i < missing.length; i += 200) {
        const chunk = missing.slice(i, i + 200);
        const info = (await call({ action: "blocks_info", hashes: chunk, json_block: true }).catch(() => ({}))) as any;
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
    for (const [h, b] of await this.fetchBlocksInfo((body) => nanoRpc(this.apiKey, body), all)) {
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
    // Serve the request-scoped memo if this account was already fetched in this
    // request. A rejected fetch is intentionally NOT memoized (delete on throw)
    // so a transient failure doesn't poison the rest of the request.
    const key = `${account}|${limit}`;
    const memo = this.blockMemo.get(key);
    if (memo) return memo;
    const p = this._listBlocks(account, limit).catch((e) => { this.blockMemo.delete(key); throw e; });
    this.blockMemo.set(key, p);
    return p;
  }

  private async _listBlocks(account: string, limit = 20000): Promise<NanoBlock[]> {
    // Best-view frontier selection. Final form of the stale-backend saga
    // (2026-08-22): a lagging backend can be SELF-CONSISTENTLY stale — old
    // frontier from account_info AND matching old history — so checking a
    // walk against "its own" frontier still accepts an outdated chain. The
    // only robust target is the BEST view: query account_info from all three
    // permitted views (nano.to keyed, nano.to keyless, nano-gpt fallback),
    // take the highest block_count as the target, and require the walk to
    // contain THAT frontier. Walks start AT the target frontier (history
    // head param): a backend that doesn't know the block yet returns nothing
    // and is retried on the other tier instead of silently serving the past.
    // A verified chain containing the highest observed frontier cannot be
    // stale by more than what NO available view has seen.
    // Fast path: warmFrontiers already resolved this account's best frontier in
    // a batched call — skip the 3 per-account account_info round-trips.
    let best: { frontier: string; height: number };
    const hinted = this.frontierHint.get(account);
    // The shared store is consulted BEFORE the probe, not after it. Measured
    // live: the probe costs 3 account_info calls per account (114 for 38
    // accounts) and used to run even when the store already held that
    // account's verified chain — the cache sat behind the very cost it exists
    // to avoid. A stored tip is monotonic (it never regresses), so leaning on
    // it can only mean "slightly behind", never "wrong".
    // No health gate here. An earlier version only allowed this when the
    // batched refresh had recently succeeded, which inverted the intent: on a
    // cold serverless instance `lastBatchOkAt` is 0, so the stored tip was
    // refused in exactly the situation it exists for. And if the batch is
    // failing, the per-account probe hits the SAME rate-limited endpoint and
    // mostly fails too — serving a last-known verified chain beats serving
    // nothing. Staleness stays visible instead: the count of accounts served
    // this way is reported as x-tips-from-cache.
    let stored: { frontier: string; height: number } | null = null;
    if (!hinted && this.opts.staleTips && this.cache) {
      try { stored = await this.cache.getFrontier(account); } catch {}
    }
    if (hinted) {
      best = { frontier: hinted, height: 0 };
    } else if (stored?.frontier) {
      best = stored;
      this.tipsFromCache.add(account);
    } else {
      const view = async (fn: () => Promise<any>) => {
        try { const i = await fn(); return { frontier: String(i?.frontier ?? ""), height: Number(i?.block_count ?? 0) }; }
        catch { return { frontier: "", height: 0 }; }
      };
      const views = await Promise.all([
        view(() => nanoRpc(this.apiKey, { action: "account_info", account })),
        view(() => nanoRpc("", { action: "account_info", account })),
        view(() => fallbackRpc({ action: "account_info", account })),
      ]);
      best = views.reduce((a, b) => (b.height > a.height ? b : a));
    }

    // Monotonic frontier: never target an OLDER tip than one we (or any other
    // instance) already saw. If the shared store has a higher frontier, adopt
    // it — a lagging RPC view can't roll the account back, so counts stay
    // stable. And if we already have that frontier's verified chain cached,
    // serve it directly (identical for every request — kills the flicker).
    if (this.cache) {
      try {
        const stored = await this.cache.getFrontier(account);
        if (stored && stored.height > best.height && stored.frontier) best = stored;
      } catch {}
      if (best.frontier) {
        try {
          const cached = await this.cache.getBlocks(account, best.frontier);
          if (cached && cached.length) { this.frontiers.set(account, cached[cached.length - 1].hash); return cached; }
        } catch {}
      }
    }

    if (!best.frontier) return []; // unopened / unknown everywhere

    // Three walk sources: nano.to keyed, nano.to keyless, and the FALLBACK
    // endpoint — the last one matters when BOTH nano.to regional tiers lag
    // (observed live: a wallet's fresh blocks visible via nano-gpt minutes
    // before nano.to's US cluster served them), since nanoRpc only fails over
    // on transport errors, never on stale-but-successful answers.
    // ESCALATE, don't fan out. This used to fire all three sources in PARALLEL
    // for every account, and collectChains walks 10 accounts at a time — about
    // 30 concurrent request chains per fold, which is what tripped the plan's
    // "burst limit exceeded" and "too many concurrent requests". The sources
    // are tried in order instead and the walk stops at the first COMPLETE one,
    // so the happy path costs a third of the calls. Correctness is unchanged:
    // "complete" still means the walk contains the best observed frontier, so
    // the first complete walk is as trustworthy as the longest of three.
    const sources: RpcCall[] = [
      (body) => nanoRpc(this.apiKey, body),
      (body) => nanoRpc("", body),
      (body) => fallbackRpc(body),
    ];
    const walks: { blocks: NanoBlock[]; complete: boolean }[] = [];
    for (let round = 0; round < 2; round++) {
      for (const source of sources) {
        let walk: { blocks: NanoBlock[]; complete: boolean } | null = null;
        try { walk = await this.fetchChain(source, account, limit, best.frontier); } catch { /* try the next source */ }
        if (!walk) continue;
        walks.push(walk);
        if (!walk.complete) continue;
        const blocks = walk.blocks;
        if (blocks.length) this.frontiers.set(account, blocks[blocks.length - 1].hash); // the replayed tip
        // Publish the complete chain + its frontier to the shared store so every
        // other request/instance serves this exact verified snapshot.
        if (this.cache && best.frontier) {
          void this.cache.putBlocks(account, best.frontier, blocks).catch(() => {});
          void this.cache.putFrontier(account, best.frontier, best.height || blocks.length).catch(() => {});
        }
        return blocks;
      }
    }
    if (walks.length === 0) throw new Error(`listBlocks(${account}): both keyed and keyless RPC failed`);
    return walks.reduce((a, b) => (b.blocks.length > a.blocks.length ? b : a)).blocks;
  }

  private async fetchChain(call: RpcCall, account: string, limit: number, frontier: string): Promise<{ blocks: NanoBlock[]; complete: boolean }> {
    // H2 fast path: if the account's frontier is unchanged, its verified block
    // list is unchanged — skip the whole history pull. Only COMPLETE chains
    // are ever cached (see below), so a hit is always frontier-consistent.
    if (frontier) {
      const hit = FRONTIER_CACHE.get(`${account}|${frontier}`);
      if (hit) return { blocks: hit, complete: true };
    }

    const raw: RawFetchedBlock[] = [];
    const seen = new Set<string>();
    // Start the walk AT the target frontier so a backend that hasn't seen it
    // yet returns nothing (→ incomplete → retried elsewhere) instead of
    // silently serving an older tip.
    let head: string | undefined = frontier || undefined;

    while (raw.length < limit) {
      const params: Record<string, unknown> = { action: "account_history", account, count: 500, raw: true };
      if (head) params.head = head;
      const hist = (await call(params)) as {
        history?: { hash: string; height: string }[];
        previous?: string;
      };
      const history = hist.history ?? [];
      if (history.length === 0) break;
      const hashes = history.map((h) => h.hash).filter((h) => !seen.has(h));
      if (hashes.length === 0) break;

      const infos = await this.fetchBlocksInfo(call, hashes);
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

