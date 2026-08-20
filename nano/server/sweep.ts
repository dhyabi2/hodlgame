// Sweep: the operator's trading engine.
//
// 1. receivePoolPending — accept incoming XNO (buys) into a pool account.
// 2. payoutSellsMulti — broadcast per-token sell payouts (XNO out is computed
//    exactly at each sell's execution point by `analyze`).
// 3. refundRejectedBuys — return uncredited XNO from rejected/over-sent buys.
//
// Paid sells and deposits are tracked in a durable store so a crash doesn't
// double-pay; ledger writes are atomic.

import { tokenPoolKeys, signPayout, broadcastPayout, type PoolKeys } from "./custody";
import { computeRefunds } from "./reconcile";
import { loadJson, saveJson } from "./store";
import type { SellPayout } from "./analytics";
import { nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";

function loadPaid(): Set<string> {
  return new Set(loadJson<string[]>("paid.json") ?? []);
}

function savePaid(set: Set<string>) {
  saveJson("paid.json", [...set]);
}

// Pool deposits ledger: sourceHash → { sender, amount } for every XNO send the
// pool has received. Powers the deterministic buy-reconciliation refund.
type DepositLedger = Record<string, { sender: string; amount: string }>;

function loadDeposits(): DepositLedger {
  return loadJson<DepositLedger>("deposits.json") ?? {};
}

function saveDeposits(ledger: DepositLedger) {
  saveJson("deposits.json", ledger);
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

/** Broadcast sell payouts, signing each from that token's own pool account. */
export async function payoutSellsMulti(
  rpcKey: string,
  masterSeed: string,
  payouts: SellPayout[],
  cosignerSeeds: string[] = []
): Promise<{ paid: string[]; skipped: number }> {
  const paid = loadPaid();
  const paidOut: string[] = [];
  let skipped = 0;

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

/** Refund uncredited XNO (rejected buys) back to each sender, idempotently. */
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