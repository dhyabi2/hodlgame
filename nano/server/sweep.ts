// Sweep: the operator's trading engine.
//
// 1. receivePoolPending — accept incoming XNO (buys) into a pool account.
// 2. settlePoolNetted — pay sells + refunds via CHAIN-DERIVED netting
//    (per recipient: entitlement − already-sent, read from the pool's own
//    chain). No private ledgers; crash- and concurrency-safe by construction.
//
// payoutSellsMulti / refundRejectedBuys / readPoolDeposits further down are
// the LEGACY store-ledger path, kept only for transition tooling.

import { tokenPoolKeys, signPayout, signPayoutWithSignatures, remoteCosign, broadcastPayout, type PoolKeys, type Payout } from "./custody";
import { computeRefunds } from "./reconcile";
import { loadJson, saveJson } from "./store";
import type { SellPayout } from "./analytics";
import { nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";
import { ANCHOR_PUB, poolHelloRepAddress } from "../core/anchor";
import { NanoRpcSource, verifyFetchedBlock, type NanoBlock } from "../indexer/blockSource";
import { poolOutgoingByRecipient, entitlementsFor, netObligations } from "./settled";

async function loadPaid(): Promise<Set<string>> {
  return new Set((await loadJson<string[]>("paid")) ?? []);
}

async function savePaid(set: Set<string>): Promise<void> {
  await saveJson("paid", [...set]);
}

// Pool deposits ledger: sourceHash → { sender, amount, tokenId } for every XNO
// send a pool has received. `tokenId` scopes a deposit to the pool it landed in
// — WITHOUT it, one token's pool would refund another token's depositors, since
// refunds compare pool-received XNO against a single token's credited buys.
type DepositLedger = Record<string, { sender: string; amount: string; tokenId?: string }>;

async function loadDeposits(): Promise<DepositLedger> {
  return (await loadJson<DepositLedger>("deposits")) ?? {};
}

async function saveDeposits(ledger: DepositLedger): Promise<void> {
  await saveJson("deposits", ledger);
}

// Refunded ledger: `${tokenId}:${sender}` → cumulative XNO already refunded.
// Makes refunds IDEMPOTENT — without it every sweep re-computes the same
// (received − credited) owed amount and pays it again, draining the pool.
type RefundedLedger = Record<string, string>;

async function loadRefunded(): Promise<RefundedLedger> {
  return (await loadJson<RefundedLedger>("refunded")) ?? {};
}

function refundedKey(tokenId: string, sender: string): string {
  return `${tokenId}:${sender}`;
}

/** Accept all pending XNO into the pool account (buys). */
export async function receivePoolPending(
  rpcKey: string,
  pool: PoolKeys,
  tokenId: string
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

/** One-time pool self-registration: a 1-raw send to the protocol anchor with
 * the tokenId encoded in the representative, so any indexer discovers the
 * pool→token binding from chain data (core/anchor.ts). Best-effort; the
 * `hellos` store entry is only a cache — a lost entry re-sends 1 raw. */
export async function ensurePoolHello(rpcKey: string, pool: PoolKeys, tokenId: string): Promise<void> {
  const hellos = (await loadJson<Record<string, string>>("hellos")) ?? {};
  if (hellos[pool.address]) return;
  try {
    const info = await nanoRpc(rpcKey, { action: "account_info", account: pool.address }).catch(() => null);
    if (!info?.frontier || BigInt(info.balance ?? "0") < 1n) return; // not opened/funded yet
    const work = (await nanoRpc(rpcKey, { action: "work_generate", hash: info.frontier, difficulty: SEND_DIFFICULTY })).work;
    const { buildStateBlock } = await import("../client/nano");
    const blk = buildStateBlock(pool.secretKey, {
      work,
      previous: info.frontier,
      representative: poolHelloRepAddress(tokenId),
      balance: (BigInt(info.balance) - 1n).toString(),
      link: ANCHOR_PUB,
    });
    await nanoRpc(rpcKey, { action: "process", json_block: "true", subtype: "send", block: blk });
    hellos[pool.address] = tokenId;
    await saveJson("hellos", hellos);
  } catch {
    /* retry next sweep */
  }
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
    hashes.push(...(await receivePoolPending(rpcKey, pool, tokenId)));
    await ensurePoolHello(rpcKey, pool, tokenId);
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
  const paid = await loadPaid();
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
    const payout: Payout = {
      to: p.to,
      amountRaw: p.amountRaw.toString(),
      frontier: poolInfo.frontier,
      balance: poolInfo.balance,
      representative: poolInfo.representative,
    };
    // Mark as paid BEFORE broadcasting and persist immediately, so a crash or a
    // concurrent/overlapping sweep can never re-pay this sell block. (Previously
    // `paid` was saved only once after the whole batch, so any mid-loop throw
    // dropped every already-broadcast entry → double payments.) If the broadcast
    // itself fails we roll the mark back so the payout is retried next sweep.
    paid.add(p.hash);
    await savePaid(paid);
    try {
      const block = await signGuardedPayout(rpcKey, pool, p.tokenId, payout, cosignerSeeds);
      const hash = await broadcastPayout(rpcKey, block);
      paidOut.push(hash);
    } catch (e) {
      paid.delete(p.hash);
      await savePaid(paid);
      skipped++;
    }
  }

  return { paid: paidOut, skipped };
}

/**
 * Sign a payout, collecting remote guardian cosignatures when GUARDIAN_URL +
 * GUARDIAN_KEY are configured (2-of-3). Falls back to single-key otherwise.
 */
async function signGuardedPayout(
  rpcKey: string,
  pool: PoolKeys,
  tokenId: string,
  payout: Payout,
  cosignerSeeds: string[]
): Promise<any> {
  const gurl = process.env.GUARDIAN_URL;
  const gkey = process.env.GUARDIAN_KEY;
  if (gurl && gkey) {
    const sigs: string[] = [];
    for (const url of gurl.split(",").map((s) => s.trim()).filter(Boolean)) {
      const s = await remoteCosign(url, gkey, { tokenId, pool, payout });
      if (s) sigs.push(s);
    }
    return signPayoutWithSignatures(pool, payout, rpcKey, sigs);
  }
  return signPayout(pool, payout, rpcKey, cosignerSeeds);
}

/**
 * Total XNO each sender has deposited into a token's pool account (received
 * ledger + still-pending), used to reconcile rejected buys.
 */
export async function readPoolDeposits(rpcKey: string, pool: PoolKeys, tokenId: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const seen = new Set<string>();

  for (const [hash, d] of Object.entries(await loadDeposits())) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (!d.sender) continue;
    if (d.tokenId !== tokenId) continue; // only THIS token's pool deposits
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
 * Refund uncredited XNO (rejected buys) back to each sender, idempotently.
 *
 * `refunds` is the TOTAL owed per sender for this token (received − credited).
 * We subtract what has already been refunded (durable `refunded` ledger) and
 * only pay the remaining delta, recording each payment immediately. This makes
 * the refund exactly-once: without it, every sweep recomputes the same owed
 * amount (the deposit ledger never shrinks and the buy stays rejected) and pays
 * it again, draining the pool.
 */
export async function refundRejectedBuys(
  rpcKey: string,
  pool: PoolKeys,
  tokenId: string,
  refunds: Map<string, bigint>
): Promise<string[]> {
  const hashes: string[] = [];
  if (refunds.size === 0) return hashes;

  const refunded = await loadRefunded();

  // Net each sender's owed amount against what was already refunded.
  const owed = new Map<string, bigint>();
  for (const [sender, total] of refunds) {
    const already = BigInt(refunded[refundedKey(tokenId, sender)] ?? "0");
    const delta = total - already;
    if (delta > 0n) owed.set(sender, delta);
  }
  if (owed.size === 0) return hashes;

  let info = await nanoRpc(rpcKey, { action: "account_info", account: pool.address, representative: "true" }).catch(() => null);
  if (!info?.frontier) return hashes;
  let frontier = info.frontier as string;
  let balance = BigInt(info.balance);

  for (const [sender, amount] of owed) {
    if (amount <= 0n) continue;
    if (amount > balance) break; // never send more than the pool holds
    const payout = await signPayout(pool, {
      to: sender,
      amountRaw: amount.toString(),
      frontier,
      balance: balance.toString(),
      representative: info.representative,
    }, rpcKey, []);
    const hash = await broadcastPayout(rpcKey, payout);
    // Record the refund immediately (exactly-once), before moving on.
    const key = refundedKey(tokenId, sender);
    refunded[key] = (BigInt(refunded[key] ?? "0") + amount).toString();
    await saveJson("refunded", refunded);
    hashes.push(hash);
    frontier = hash;
    balance = balance - amount;
    info = { ...info, frontier: hash, balance: balance.toString() };
  }
  return hashes;
}
// ── Chain-derived settlement (roadmap W2/W4) ────────────────────────────────
// The functions above (payoutSellsMulti / readPoolDeposits / refundRejectedBuys
// and their private paid/refunded/deposits ledgers) are the LEGACY path, kept
// for transition tooling only. The functions below settle from chain state
// alone — see server/settled.ts for the netting rule.

/** Sender → Σ XNO deposited into the pool, derived from the pool's own chain
 * (confirmed receives + still-pending sends). Every source block is verified
 * locally before its sender/amount is trusted. */
export async function readPoolDepositsFromChain(
  rpcKey: string,
  pool: PoolKeys,
  poolBlocks: NanoBlock[]
): Promise<Map<string, bigint>> {
  const sourceHashes = poolBlocks
    .filter((b) => (b.subtype === "receive" || b.subtype === "open") && /^[0-9a-fA-F]{64}$/.test(b.link))
    .map((b) => b.link);
  const pend = await nanoRpc(rpcKey, { action: "pending", account: pool.address, count: 500 }).catch(() => ({}));
  const all = [...new Set([...sourceHashes, ...(((pend as any).blocks ?? []) as string[])])];

  const out = new Map<string, bigint>();
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    const info = (await nanoRpc(rpcKey, { action: "blocks_info", hashes: chunk, json_block: true })) as any;
    for (const h of chunk) {
      const b = info.blocks?.[h];
      if (!b?.block_account) continue;
      if (!verifyFetchedBlock(h, b)) continue;
      const amount = BigInt(b.amount ?? "0");
      if (amount <= 0n) continue;
      out.set(b.block_account, (out.get(b.block_account) ?? 0n) + amount);
    }
  }
  return out;
}

/**
 * Settle one pool from chain state: pay each recipient
 * max(0, sells+refunds − alreadySent). No private ledgers; a concurrent or
 * restarted sweeper re-derives identical obligations in identical order, so
 * duplicate broadcasts collapse to the same blocks. `queued` counts
 * obligations left unpaid this round (pool balance short / broadcast failed) —
 * they simply remain owed and retry next sweep.
 */
export async function settlePoolNetted(
  rpcKey: string,
  pool: PoolKeys,
  tokenId: string,
  sells: SellPayout[],
  credits: Map<string, bigint>
): Promise<{ paid: string[]; queued: number }> {
  const src = new NanoRpcSource(rpcKey);
  const poolBlocks = await src.listBlocks(pool.address);
  const poolReceived = await readPoolDepositsFromChain(rpcKey, pool, poolBlocks);
  const refunds = computeRefunds(poolReceived, credits);
  const entitled = entitlementsFor(tokenId, sells, refunds);
  const obligations = netObligations(entitled, poolOutgoingByRecipient(poolBlocks));

  const paid: string[] = [];
  let queued = 0;
  if (obligations.length === 0) return { paid, queued };

  const info = await nanoRpc(rpcKey, { action: "account_info", account: pool.address, representative: "true" }).catch(() => null);
  if (!info?.frontier) return { paid, queued: obligations.length };
  let frontier = info.frontier as string;
  let balance = BigInt(info.balance);

  for (const ob of obligations) {
    if (ob.amountRaw > balance) {
      queued++;
      continue; // pool can't cover it yet — stays owed, retried next sweep
    }
    try {
      const block = await signGuardedPayout(rpcKey, pool, tokenId, {
        to: ob.recipient,
        amountRaw: ob.amountRaw.toString(),
        frontier,
        balance: balance.toString(),
        representative: info.representative,
      }, []);
      const hash = await broadcastPayout(rpcKey, block);
      paid.push(hash);
      frontier = hash;
      balance -= ob.amountRaw;
    } catch {
      queued++; // chain state unchanged → same obligation re-derives next sweep
    }
  }
  return { paid, queued };
}
