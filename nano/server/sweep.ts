// Sweep: the operator's trading engine.
//
// 1. receivePoolPending — accept incoming XNO (buys) into the pool account.
// 2. payoutSells — for each unpaid sell op, compute the AMM XNO out and
//    broadcast a pool → user send.
//
// Paid sells are tracked in a local file so a crash doesn't double-pay.

import * as fs from "node:fs";
import { poolKeysFromSeed, signPayout, broadcastPayout, type PoolKeys } from "./custody";
import { replayState, readOps } from "./indexer";
import { applyOp, emptyState, type State } from "../core/state";
import { decodeOpCompact } from "../core/compact";
import { nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";

const PAID_FILE = ".paid.json";

function loadPaid(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(PAID_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

function savePaid(set: Set<string>) {
  fs.writeFileSync(PAID_FILE, JSON.stringify([...set], null, 2));
}

/** Accept all pending XNO into the pool account (buys). */
export async function receivePoolPending(
  rpcKey: string,
  pool: PoolKeys
): Promise<string[]> {
  const pending = await nanoRpc(rpcKey, { action: "pending", account: pool.address, count: 100 });
  const blocks: string[] = pending.blocks ?? [];
  const hashes: string[] = [];

  let info = await nanoRpc(rpcKey, { action: "account_info", account: pool.address, representative: "true" }).catch(() => null);
  let frontier = info?.frontier ?? null;
  let balance = BigInt(info?.balance ?? "0");
  const rep = info?.representative ?? pool.address;

  for (const srcHash of blocks) {
    const srcInfo = await nanoRpc(rpcKey, { action: "block_info", hash: srcHash, json_block: true });
    const amount = BigInt(srcInfo.amount);
    const newBalance = (balance + amount).toString();
    const work = (await nanoRpc(rpcKey, {
      action: "work_generate",
      hash: frontier ?? pool.publicKey,
      difficulty: SEND_DIFFICULTY,
    })).work;

    const { buildStateBlock } = await import("../client/nano");
    const blk = buildStateBlock(pool.secretKey, {
      work,
      previous: frontier,
      representative: rep,
      balance: newBalance,
      link: srcHash,
    });
    const r = await nanoRpc(rpcKey, { action: "process", json_block: "true", subtype: "receive", block: blk });
    hashes.push(r.hash);
    frontier = r.hash;
    balance = balance + amount;
  }
  return hashes;
}

/**
 * Replay state and pay out any unpaid sells. Returns the payouts broadcast.
 */
export async function payoutSells(
  rpcKey: string,
  pool: PoolKeys,
  meta: { name: string; symbol: string; decimals: number; image: string },
  watchedAccounts: string[],
  cosignerSeeds: string[] = []
): Promise<{ paid: string[]; skipped: number }> {
  const paid = loadPaid();
  const paidOut: string[] = [];
  let skipped = 0;

  // Collect sell ops (with their block hash) across watched accounts.
  const sells: { sender: string; tokens: bigint; minXno: bigint; hash: string }[] = [];
  for (const acct of watchedAccounts) {
    const hist = await nanoRpc(rpcKey, { action: "account_history", account: acct, count: 500, raw: true });
    const history = (hist.history ?? []) as { hash: string; height: string }[];
    const info = await nanoRpc(rpcKey, { action: "blocks_info", hashes: history.map((h) => h.hash), json_block: true });
    for (const h of history) {
      const link = info.blocks?.[h.hash]?.contents?.link;
      if (!link) continue;
      try {
        const op = decodeOpCompact(link, meta);
        if (op.kind === "sell") {
          sells.push({ sender: acct, tokens: op.tokens, minXno: op.minXno, hash: h.hash });
        }
      } catch {
        /* not an op */
      }
    }
  }

  // Recompute the AMM state up to each sell to get the exact XNO out.
  const { state } = await replayState(rpcKey, meta, watchedAccounts);
  let poolInfo = await nanoRpc(rpcKey, { action: "account_info", account: pool.address, representative: "true" }).catch(() => null);
  if (!poolInfo?.frontier) return { paid: paidOut, skipped };

  for (const s of sells) {
    if (paid.has(s.hash)) continue;
    const xnoReserve = state.poolXno;
    const tokenReserve = state.poolTokens;
    if (xnoReserve <= 0n || tokenReserve <= 0n) {
      skipped++;
      continue;
    }
    const out = (s.tokens * xnoReserve) / (tokenReserve + s.tokens);
    if (out <= 0n || out >= xnoReserve) {
      skipped++;
      continue;
    }
    const payout = await signPayout(pool, {
      to: s.sender,
      amountRaw: out.toString(),
      frontier: poolInfo.frontier,
      balance: poolInfo.balance,
      representative: poolInfo.representative,
    }, rpcKey, cosignerSeeds);
    const hash = await broadcastPayout(rpcKey, payout);
    paidOut.push(hash);
    paid.add(s.hash);
    poolInfo = { ...poolInfo, frontier: hash, balance: (BigInt(poolInfo.balance) - out).toString() };
  }

  savePaid(paid);
  return { paid: paidOut, skipped };
}
