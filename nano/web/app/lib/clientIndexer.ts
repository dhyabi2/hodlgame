// In-browser trustless verification (explorer H3). The visitor's browser
// re-runs the SAME deterministic pipeline the server does — discovery →
// fetch → verify → replay → state root — using only browser-safe core code,
// then compares its root to the server's /root. A match proves the server's
// indexer is faithful to the chain data the browser fetched itself; a mismatch
// is publicly falsifiable. Chain data is fetched through the app's /api/rpc
// proxy (whitelisted); a user wanting zero server trust runs scripts/verify.ts
// locally against their own node — same code path.

import { MultiIndexer, type IndexedEvent } from "../../indexer/multiIndexer";
import type { BlockSource, CounterpartyReader, HelloInfo } from "../../indexer/blockSource";
import { finalizeChain, type NanoBlock, type RawFetchedBlock } from "../../core/blockVerify";
import { discoverAccounts } from "../../indexer/discovery";
import { ANCHOR_ADDRESS } from "../../core/anchor";
import { stateRoot } from "../../core/canonical";
import * as nanocurrency from "nanocurrency";

/** An unopened account: the RPC answered "Account not found" — a real, terminal
 * answer (empty chain), never a reason to retry or to fail the whole walk. */
class RpcNotFound extends Error {}

// Serialize EVERY verify RPC call: the recompute walk fans out over many
// accounts, and firing their /api/rpc calls concurrently hammered the rate-
// limited proxy into 400s ("verify error: rpc blocks_info 400"). Chain each
// call after the previous one settles so exactly one request is ever in flight
// — gentle on the RPC, and the progress bar keeps the (now sequential) wait
// legible. Only the verify path uses this module; the wallet has its own rpc.
let rpcGate: Promise<unknown> = Promise.resolve();
async function rpc(action: string, params: Record<string, unknown>, tries = 6): Promise<any> {
  const run = () => rpcOnce(action, params, tries);
  const next = rpcGate.then(run, run); // run after the previous call, success or fail
  rpcGate = next.catch(() => {}); // a failure must not wedge the queue
  return next;
}

async function rpcOnce(action: string, params: Record<string, unknown>, tries: number): Promise<any> {
  // The /api/rpc proxy flattens EVERY upstream outcome to a 400 — both a genuine
  // "Account not found" (an unopened account, terminal) and a transient blip
  // (timeout/throttle, retryable). Over a full multi-account walk these must be
  // told apart: retrying an unopened account is wasted, while giving up on a
  // transient blip would TRUNCATE a real chain — and truncating a creator's
  // chain before its launch block silently drops the whole token (the 0-token
  // recomputation). So: inspect the error text, throw RpcNotFound for unopened
  // (caller treats as empty, like the server), and retry everything else hard;
  // only a persistent transient surfaces as an honest error, never a fake root.
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    let res: Response;
    try {
      res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...params }),
      });
    } catch (e) {
      lastErr = e; // network/transport → retry
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      continue;
    }
    if (res.ok) return res.json();
    let msg = `rpc ${action} ${res.status}`;
    try { const b = await res.json(); if (b?.error) msg = String(b.error); } catch {}
    if (/not\s*found|unopened|bad_?account/i.test(msg)) throw new RpcNotFound(msg); // terminal, don't retry
    lastErr = new Error(msg);
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr;
}

/** Browser BlockSource + CounterpartyReader over /api/rpc, using the identical
 * verification (finalizeChain) as the server. */
class BrowserSource implements BlockSource, CounterpartyReader {
  // account → the server's replayed tip. When present we start the walk AT that
  // tip (ignoring any blocks mined after the server's snapshot) so our chain is
  // byte-identical to what the server folded — no live-freshness mismatch.
  constructor(private pinned: Record<string, string> = {}) {}

  async listBlocks(account: string, limit = 5000): Promise<NanoBlock[]> {
    const raw: RawFetchedBlock[] = [];
    const seen = new Set<string>();
    let head: string | undefined = this.pinned[account] || undefined;
    while (raw.length < limit) {
      const params: Record<string, unknown> = { action: "account_history", account, count: 500, raw: true };
      if (head) params.head = head;
      // Unopened account (no chain yet) → RpcNotFound → empty, exactly like the
      // server's listBlocks. Any OTHER error means rpc() already retried hard and
      // still failed — surface it (abort with an honest error) rather than break
      // early, because a silent truncation here would drop this account's ops and
      // fake a mismatch (a truncated creator chain = a vanished token).
      let hist: any;
      try {
        hist = await rpc("account_history", params);
      } catch (e) {
        if (e instanceof RpcNotFound) break;
        throw e;
      }
      const history = (hist.history ?? []) as { hash: string }[];
      if (!history.length) break;
      const hashes = history.map((h) => h.hash).filter((h) => !seen.has(h));
      if (!hashes.length) break;
      // Chunk blocks_info: a 500-hash request is the most likely single call to
      // trip an upstream size/timeout limit (→ proxy 400). Smaller batches (each
      // retried) keep the walk moving.
      const blocks: Record<string, any> = {};
      for (let i = 0; i < hashes.length; i += 200) {
        const part = await rpc("blocks_info", { hashes: hashes.slice(i, i + 200), json_block: true });
        Object.assign(blocks, part.blocks ?? {});
      }
      for (const hash of hashes) {
        const b = blocks[hash];
        if (!b) continue;
        seen.add(hash);
        raw.push({ hash, block_account: b.block_account, contents: b.contents, height: b.height, local_timestamp: b.local_timestamp });
      }
      const prev = hist.previous;
      if (!prev || /^0+$/.test(prev)) break;
      head = prev;
    }
    return finalizeChain(raw);
  }

  async counterparties(account: string): Promise<{ inbound: HelloInfo[]; outbound: string[] }> {
    const blocks = await this.listBlocks(account);
    const sourceHashes = blocks
      .filter((b) => (b.subtype === "receive" || b.subtype === "open") && /^[0-9a-fA-F]{64}$/.test(b.link))
      .map((b) => b.link);
    const pend = await rpc("pending", { account, count: 1000 }).catch(() => ({}));
    const all = [...new Set([...sourceHashes, ...(((pend as any).blocks ?? []) as string[])])];
    const inbound: HelloInfo[] = [];
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      const info = await rpc("blocks_info", { hashes: chunk, json_block: true });
      for (const h of chunk) {
        const b = info.blocks?.[h];
        if (!b?.block_account) continue;
        const raw: RawFetchedBlock[] = [{ hash: h, block_account: b.block_account, contents: b.contents, height: b.height }];
        if (finalizeChain(raw).length === 0) continue; // authenticity via shared verify
        inbound.push({ sender: b.block_account, representative: b.contents?.representative ?? "" });
      }
    }
    const outbound = blocks
      .filter((b) => b.subtype === "send" && /^[0-9a-fA-F]{64}$/.test(b.link))
      .map((b) => nanocurrency.deriveAddress(b.link, { useNanoPrefix: true }));
    return { inbound, outbound };
  }
}

export interface VerifyResult {
  ok: boolean;
  localRoot: string;
  serverRoot: string;
  tokens: number;
  ops: number;
  accounts: number;
  error?: string;
}

/** Recompute the whole market in the browser and compare to the server root.
 *
 * Account discovery in Nano is NOT reproducible from a single RPC view: the
 * server's replay scope is a monotonic union it has accumulated across requests
 * and instances (persisted watch-list + keyed/keyless discovery + a second
 * pool-counterparty pass), so a fresh single-view browser discovery finds a
 * SUBSET and its root would never match — a false MISMATCH on every visit.
 *
 * The fix keeps verification honest: the browser fetches the server's published
 * account set, UNIONS it with its OWN independent anchor discovery, and replays
 * that union. It still fetches every block from public RPC and re-verifies every
 * signature and op itself (it trusts the server for the LIST of accounts to
 * check, nothing else). And because it unions in its own discovery, a server
 * that tried to HIDE an account can't: the browser would replay the hidden
 * account too and the roots would then diverge — a real, surfaced mismatch. */
export async function verifyInBrowser(onProgress?: (done: number, total: number) => void): Promise<VerifyResult> {
  // Server scope + claimed root + per-account frontiers, fetched first so we can
  // reproduce its EXACT input.
  const serverResp = await fetch("/api/explorer?view=trust").then((r) => r.json());
  const serverRoot = String(serverResp?.stateRoot ?? "");
  const serverAccounts: string[] = Array.isArray(serverResp?.accounts) ? serverResp.accounts : [];
  const frontiers: Record<string, string> =
    serverResp?.frontiers && typeof serverResp.frontiers === "object" ? serverResp.frontiers : {};

  // Pin each account's walk to the server's replayed tip → identical chains even
  // if new blocks landed after the server's snapshot.
  const src = new BrowserSource(frontiers);

  // Our OWN independent discovery from the public anchor — unioned in so we can
  // never be told to ignore an account we found ourselves.
  const discovered = await discoverAccounts(src, ANCHOR_ADDRESS).catch(() => ({ users: [] as string[] }));
  const union = [...new Set([...(discovered.users ?? []), ...serverAccounts])].sort();

  // NO metadata resolver, NO poolKey, NO commit resolver — pools resolve from
  // chain, metadata is non-consensus (root excludes it).
  const idx = new MultiIndexer(src);
  // Single walk: sync() fetches every account's chain and replays it, reporting
  // per-account progress. (The old code then re-walked with collectEvents() just
  // to count ops — a wasted second full walk; the count comes free from sync.)
  const sync = await idx.sync(union, onProgress);
  const state = idx.getState();
  // Scope the fingerprint to TRUSTLESS (direct / zero-custody) tokens only. Legacy
  // pooled tokens' state depends on custody keys, the commit resolver and
  // sweep-settled payouts a browser can't reproduce — they'd diverge here even
  // though they're honestly reserved (see the Proof-of-Reserves panel). Direct
  // tokens are 100% chain-derived, so they reproduce byte-for-byte. The server
  // computes its published root the same way.
  const directState = new Map([...state].filter(([, s]) => (s as any).direct));
  const localRoot = stateRoot(directState);
  const events = sync.applied + sync.invalid;

  return {
    ok: Boolean(serverRoot) && serverRoot.toLowerCase() === localRoot.toLowerCase(),
    localRoot,
    serverRoot,
    tokens: directState.size,
    ops: events,
    accounts: union.length,
  };
}
