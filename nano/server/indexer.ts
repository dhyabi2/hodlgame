// Indexer: replay Nano blocks into the deterministic token state.
//
// v1 watches the pool account (XNO buys) and a list of watched accounts (ops).
// Each op is a "send" block (balance −1 raw) whose `link` is the compact op.

import { emptyState, applyOp, type State } from "../core/state";
import { decodeOpCompact } from "../core/compact";
import { nanoRpc } from "../lib/rpc";

export interface IndexedEvent {
  sender: string;
  op: ReturnType<typeof decodeOpCompact>;
  height: bigint;
}

/**
 * Read a Nano account's history and decode the compact ops it carries in
 * its `link` fields. Returns events in confirmation order.
 */
export async function readOps(
  rpcKey: string,
  account: string,
  meta?: { name: string; symbol: string; decimals: number; image: string }
): Promise<IndexedEvent[]> {
  const hist = await nanoRpc(rpcKey, { action: "account_history", account, count: 500, raw: true });
  const history = (hist.history ?? []) as { hash: string; height: string }[];
  if (history.length === 0) return [];

  const info = await nanoRpc(rpcKey, {
    action: "blocks_info",
    hashes: history.map((h) => h.hash),
    json_block: true,
  });

  const events: IndexedEvent[] = [];
  for (const h of history) {
    const b = info.blocks?.[h.hash];
    const link = b?.contents?.link;
    if (!link) continue;
    try {
      const op = decodeOpCompact(link, meta);
      events.push({ sender: account, op, height: BigInt(h.height) });
    } catch {
      // Not a HoldFun op (e.g. a plain transfer) — skip.
    }
  }
  events.sort((a, b) => (a.height < b.height ? -1 : 1));
  return events;
}

/** Replay the pool (buys) and watched accounts (ops) into token state. */
export async function replayState(
  rpcKey: string,
  meta: { name: string; symbol: string; decimals: number; image: string },
  watchedAccounts: string[]
): Promise<{ state: State; events: number }> {
  let state = emptyState();
  let total = 0;
  const all: IndexedEvent[] = [];
  for (const acct of watchedAccounts) {
    const evs = await readOps(rpcKey, acct, meta);
    all.push(...evs);
  }
  all.sort((a, b) => (a.height < b.height ? -1 : 1));
  for (const e of all) {
    try {
      state = applyOp(state, e.op, e.sender, e.height);
      total++;
    } catch {
      // invalid op — skip, keep canonical state
    }
  }
  return { state, events: total };
}
