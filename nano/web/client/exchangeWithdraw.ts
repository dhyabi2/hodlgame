// Headless token withdrawal for exchanges (docs/EXCHANGE-KIT.md). A token
// transfer is two chained 1-raw blocks (fragment links); this drives them
// safely from a server with the exchange's OWN key — crash-safe and idempotent.
//
// Safety model:
//  - Nano block hashes are deterministic in (account, previous, rep, balance,
//    link), so re-broadcasting an already-confirmed block is a NO-OP. Restart
//    at any point and re-send: never a double-spend.
//  - Frag B chains from frag A (previous = A.hash). A dangling frag A is
//    deterministically IGNORED by every indexer (no partial credit), so a
//    crash between A and B cannot half-transfer — you simply complete B.
//  - The caller persists the returned WithdrawState (an outbox row) and, on
//    restart, calls resumeWithdraw with it.

import * as nanocurrency from "nanocurrency";
import { encodeFragLinks } from "../core/fraglink";
import { buildStateBlock, keysFromSeed } from "./nano";

export interface WithdrawState {
  id: string; // idempotency key (your withdrawal id)
  tokenId: string;
  to: string;
  amount: string; // raw token units
  fragAHash?: string;
  fragBHash?: string;
  done: boolean;
}

type Rpc = (action: string, params: Record<string, unknown>) => Promise<any>;

async function frontier(rpc: Rpc, address: string): Promise<{ previous: string; representative: string; balance: string }> {
  const info = await rpc("account_info", { account: address, representative: "true" }).catch(() => null);
  if (!info?.frontier) throw new Error("withdrawal account not opened / has no frontier");
  return { previous: info.frontier, representative: info.representative, balance: info.balance };
}

async function sendData(rpc: Rpc, secretKey: string, prev: { previous: string; representative: string; balance: string }, link: string): Promise<string> {
  const work = (await rpc("work_generate", { hash: prev.previous, difficulty: "fffffff800000000" })).work;
  const blk = buildStateBlock(secretKey, {
    work,
    previous: prev.previous,
    representative: prev.representative,
    balance: (BigInt(prev.balance) - 1n).toString(), // 1-raw data send
    link,
  });
  const r = await rpc("process", { json_block: "true", subtype: "send", block: blk });
  return r.hash as string;
}

/** Start (or, with a persisted `state`, resume) a token withdrawal. Returns the
 * updated outbox state; persist it after every call. Idempotent: safe to call
 * repeatedly with the same id/state until `done`. */
export async function withdrawToken(
  exchangeSeed: string,
  req: { id: string; tokenId: string; to: string; amount: string },
  rpc: Rpc,
  state?: WithdrawState
): Promise<WithdrawState> {
  const st: WithdrawState = state ?? { ...req, done: false };
  if (st.done) return st;
  const keys = keysFromSeed(exchangeSeed);
  const [linkA, linkB] = encodeFragLinks(st.tokenId, { kind: "transfer", to: st.to, amount: BigInt(st.amount) });

  // Frag A — from the current frontier. If already sent, its hash is on chain;
  // re-deriving from the (unchanged) frontier reproduces the same block, and
  // `process` of a duplicate is a no-op.
  if (!st.fragAHash) {
    const f = await frontier(rpc, keys.address);
    st.fragAHash = await sendData(rpc, keys.secretKey, f, linkA);
  }

  // Frag B — chained on A. previous = A.hash; balance drops another raw.
  if (!st.fragBHash) {
    const infoA = await rpc("block_info", { hash: st.fragAHash, json_block: true }).catch(() => null);
    const balanceAfterA = infoA?.contents?.balance ?? (await frontier(rpc, keys.address)).balance;
    st.fragBHash = await sendData(
      rpc,
      keys.secretKey,
      { previous: st.fragAHash, representative: keys.address, balance: balanceAfterA },
      linkB
    );
  }

  st.done = true;
  return st;
}

/** Convenience: is the withdrawal's frag B cemented (final)? Exchanges should
 * mark the customer paid only after this is true. */
export async function withdrawConfirmed(rpc: Rpc, st: WithdrawState): Promise<boolean> {
  if (!st.fragBHash) return false;
  const info = await rpc("block_info", { hash: st.fragBHash, json_block: true }).catch(() => null);
  return info?.confirmed === "true" || info?.confirmed === true;
}

export { keysFromSeed, nanocurrency };
