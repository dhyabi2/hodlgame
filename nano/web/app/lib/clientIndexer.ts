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

async function rpc(action: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...params }),
  });
  if (!res.ok) throw new Error(`rpc ${action} ${res.status}`);
  return res.json();
}

/** Browser BlockSource + CounterpartyReader over /api/rpc, using the identical
 * verification (finalizeChain) as the server. */
class BrowserSource implements BlockSource, CounterpartyReader {
  async listBlocks(account: string, limit = 5000): Promise<NanoBlock[]> {
    const raw: RawFetchedBlock[] = [];
    const seen = new Set<string>();
    let head: string | undefined;
    while (raw.length < limit) {
      const params: Record<string, unknown> = { action: "account_history", account, count: 500, raw: true };
      if (head) params.head = head;
      const hist = await rpc("account_history", params).catch(() => ({}));
      const history = (hist.history ?? []) as { hash: string }[];
      if (!history.length) break;
      const hashes = history.map((h) => h.hash).filter((h) => !seen.has(h));
      if (!hashes.length) break;
      const info = await rpc("blocks_info", { hashes, json_block: true });
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
export async function verifyInBrowser(): Promise<VerifyResult> {
  const src = new BrowserSource();

  // Server scope + claimed root, fetched first so we can reproduce its exact set.
  const serverResp = await fetch("/api/explorer?view=trust").then((r) => r.json());
  const serverRoot = String(serverResp?.stateRoot ?? "");
  const serverAccounts: string[] = Array.isArray(serverResp?.accounts) ? serverResp.accounts : [];

  // Our OWN independent discovery from the public anchor — unioned in so we can
  // never be told to ignore an account we found ourselves.
  const discovered = await discoverAccounts(src, ANCHOR_ADDRESS).catch(() => ({ users: [] as string[] }));
  const union = [...new Set([...(discovered.users ?? []), ...serverAccounts])].sort();

  // NO metadata resolver, NO poolKey, NO commit resolver — pools resolve from
  // chain, metadata is non-consensus (root excludes it).
  const idx = new MultiIndexer(src);
  const sync = await idx.sync(union);
  const state = idx.getState();
  const localRoot = stateRoot(state);

  let events = 0;
  try {
    events = (await idx.collectEvents(union)).length;
  } catch {
    events = sync.applied;
  }

  return {
    ok: Boolean(serverRoot) && serverRoot.toLowerCase() === localRoot.toLowerCase(),
    localRoot,
    serverRoot,
    tokens: state.size,
    ops: events,
    accounts: union.length,
  };
}
