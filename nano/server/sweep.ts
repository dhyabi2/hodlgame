// Sweep: the operator's trading engine.
//
// 1. receivePoolPending — accept incoming XNO (buys) into the pool account.
// 2. payoutSells — for each unpaid sell op, compute the AMM XNO out and
//    broadcast a pool → user send.
//
// Paid sells are tracked in a local file so a crash doesn't double-pay.

import * as fs from "node:fs";
import { poolKeysFromSeed, tokenPoolKeys, signPayout, broadcastPayout, type PoolKeys } from "./custody";
import { replayState, readOps } from "./indexer";
import { planSellPayouts } from "./plan";
import { computeRefunds } from "./reconcile";
import { atomicWrite } from "./fsutil";
import { applyOp, emptyState, type State } from "../core/state";
import { decodeOpCompact } from "../core/compact";
import type { MultiState } from "../core/multi";
import type { SellRecord } from "../indexer/multiIndexer";
import { nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";

const PAID_FILE = ".paid.json";
const DEPOSITS_FILE = ".deposits.json";

function loadPaid(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(PAID_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

function savePaid(set: Set<string>) {
  atomicWrite(PAID_FILE, JSON.stringify([...set], null, 2));
}

// Pool deposits ledger: sourceHash → { sender, amount } for every XNO send the
// pool has received. Powers the deterministic buy-reconciliation refund.
type DepositLedger = Record<string, { sender: string; amount: string }>;

function loadDeposits(): DepositLedger {
  try {
    return JSON.parse(fs.readFileSync(DEPOSITS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveDeposits(ledger: DepositLedger) {
  atomicWrite(DEPOSITS_FILE, JSON.stringify(ledger, null, 2));
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

  const ledger = loadDeposits();
  for (const srcHash of blocks) {
    const srcInfo = await nanoRpc(rpcKey, { action: "block_info", hash: srcHash, json_block: true });
    const amount = BigInt(srcInfo.amount);
    if (!ledger[srcHash]) {
      ledger[srcHash] = {
        sender: String(srcInfo.block_account ?? srcInfo.contents?.account ?? ""),
        amount: String(amount),
      };
    }
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
  saveDeposits(ledger);
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

/** Receive pending XNO (buys) into every token's own pool account. */
export async function receivePoolsMulti(
  rpcKey: string,
  masterSeed: string,
  tokenIds: string[]
): Promise<string[]> {
  const hashes: string[] = [];
  for (const tokenId of tokenIds) {
    const pool = tokenPoolKeys(masterSeed, tokenId);
    hashes.push(...(await receivePoolPending(rpcKey, pool)));
  }
  return hashes;
}

/**
 * Payout sells per token, signing each from that token's own pool account.
 * Uses planSellPayouts (pure) then broadcasts the planned sends.
 */
export async function payoutSellsMulti(
  rpcKey: string,
  masterSeed: string,
  state: MultiState,
  sells: SellRecord[],
  cosignerSeeds: string[] = []
): Promise<{ paid: string[]; skipped: number }> {
  const paid = loadPaid();
  const paidOut: string[] = [];
  let skipped = 0;

  const { payouts, skipped: skippedPlan } = planSellPayouts(state, sells);
  skipped += skippedPlan.length;

  for (const p of payouts) {
    if (paid.has(p.hash)) continue;
    const pool = tokenPoolKeys(masterSeed, p.tokenId);
    const poolInfo = await nanoRpc(rpcKey, { action: "account_info", account: pool.address, representative: "true" }).catch(() => null);
    if (!poolInfo?.frontier) {
      skipped++;
      continue;
    }
    const payout = await signPayout(pool, {
      to: p.to,
      amountRaw: p.amountRaw.toString(),
      frontier: poolInfo.frontier,
      balance: poolInfo.balance,
      representative: poolInfo.representative,
    }, rpcKey, cosignerSeeds);
    const hash = await broadcastPayout(rpcKey, payout);
    paidOut.push(hash);
    paid.add(p.hash);
  }

  savePaid(paid);
  return { paid: paidOut, skipped };
}

/**
 * Total XNO each sender has deposited into a token's pool account (received
 * ledger + still-pending), used to reconcile rejected buys.
 */
export async function readPoolDeposits(rpcKey: string, pool: PoolKeys): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const seen = new Set<string>();

  for (const [hash, d] of Object.entries(loadDeposits())) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (!d.sender) continue;
    out.set(d.sender, (out.get(d.sender) ?? 0n) + BigInt(d.amount));
  }

  const pending = await nanoRpc(rpcKey, { action: "pending", account: pool.address, count: 200 });
  for (const srcHash of (pending.blocks ?? []) as string[]) {
    if (seen.has(srcHash)) continue;
    seen.add(srcHash);
    const src = await nanoRpc(rpcKey, { action: "block_info", hash: srcHash, json_block: true });
    const sender = String(src.block_account ?? src.contents?.account ?? "");
    const amount = BigInt(src.amount ?? "0");
    if (!sender || amount <= 0n) continue;
    out.set(sender, (out.get(sender) ?? 0n) + amount);
  }
  return out;
}

/**
 * Refund the uncredited XNO (rejected/over-sent buys) back to each sender from
 * the token's pool account. Idempotent: once refunded, the deposit ledger entry
 * is removed so it is not refunded twice.
 */
export async function refundRejectedBuys(
  rpcKey: string,
  pool: PoolKeys,
  refunds: Map<string, bigint>
): Promise<string[]> {
  const hashes: string[] = [];
  if (refunds.size === 0) return hashes;

  let info = await nanoRpc(rpcKey, { action: "account_info", account: pool.address, representative: "true" }).catch(() => null);
  if (!info?.frontier) return hashes;
  let frontier = info.frontier as string;
  let balance = BigInt(info.balance);

  for (const [sender, amount] of refunds) {
    if (amount <= 0n) continue;
    const payout = await signPayout(pool, {
      to: sender,
      amountRaw: amount.toString(),
      frontier,
      balance: balance.toString(),
      representative: info.representative,
    }, rpcKey, []);
    const hash = await broadcastPayout(rpcKey, payout);
    hashes.push(hash);
    frontier = hash;
    balance = balance - amount;
    info = { ...info, frontier: hash, balance: balance.toString() };
  }
  return hashes;
}
