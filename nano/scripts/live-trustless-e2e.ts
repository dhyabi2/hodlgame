// Live end-to-end of the trustless stack against the REAL Nano network:
// anchor hello → launch → compact seedLiq (deposit-chained) → value-bound buy
// → fragment sell (minXno) → fragment transfer → chain-derived settlement →
// secretless indexer replay + discovery. Uses micro amounts (≤1e25 raw total).
//
//   npx tsx scripts/live-trustless-e2e.ts
//
// Needs .keys.json: nanoRpcKey, anchorSeed (funded), testSeed (auto-funded
// from the anchor on first run).

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { nanoRpc, loadNanoRpcKey, SEND_DIFFICULTY, RECEIVE_DIFFICULTY } from "../lib/rpc";
import { buildStateBlock } from "../client/nano";
import { encodeOpLink } from "../core/oplink";
import { encodeFragLinks } from "../core/fraglink";
import { tokenIdFromLaunchHash } from "../core/token";
import { ANCHOR_ADDRESS, ANCHOR_PUB } from "../core/anchor";
import { tokenPoolKeys } from "../server/custody";
import { receivePoolPending, ensurePoolHello, settlePoolNetted } from "../server/sweep";
import { creditedBuys } from "../server/reconcile";
import { analyze } from "../server/analytics";
import { MultiIndexer } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { discoverAccounts } from "../indexer/discovery";
import { stateRoot } from "../core/canonical";
import type { Op } from "../core/ops";

const key = loadNanoRpcKey();
const KEYS = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));

function wallet(seed: string, index = 0) {
  const secretKey = nanocurrency.deriveSecretKey(seed, index);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  return { secretKey, publicKey, address: nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function work(hash: string, difficulty: string): Promise<string> {
  return (await nanoRpc(key, { action: "work_generate", hash, difficulty })).work;
}

async function accountInfo(address: string): Promise<any | null> {
  return nanoRpc(key, { action: "account_info", account: address, representative: "true" }).catch(() => null);
}

/** Receive every pending block into an account (opens it if needed). */
async function receiveAll(w: ReturnType<typeof wallet>): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const pend = await nanoRpc(key, { action: "pending", account: w.address, count: 10 }).catch(() => ({}));
    const blocks: string[] = Array.isArray((pend as any).blocks) ? (pend as any).blocks : Object.keys((pend as any).blocks ?? {});
    if (!blocks.length) return;
    for (const src of blocks) {
      const srcInfo = await nanoRpc(key, { action: "block_info", hash: src, json_block: true });
      const info = await accountInfo(w.address);
      const previous = info?.frontier ?? null;
      const balance = (BigInt(info?.balance ?? "0") + BigInt(srcInfo.amount)).toString();
      const w0 = await work(previous ?? w.publicKey, RECEIVE_DIFFICULTY);
      const blk = buildStateBlock(w.secretKey, {
        work: w0,
        previous,
        representative: info?.representative ?? w.address,
        balance,
        link: src,
      });
      await nanoRpc(key, { action: "process", json_block: "true", subtype: previous ? "receive" : "open", block: blk });
      console.log(`  received ${srcInfo.amount} raw into ${w.address.slice(0, 12)}…`);
    }
    await sleep(500);
  }
}

/** Send from a wallet: destination = address or 64-hex link (data send). */
async function send(w: ReturnType<typeof wallet>, linkOrAddress: string, amountRaw: bigint): Promise<string> {
  const info = await accountInfo(w.address);
  if (!info?.frontier) throw new Error(`${w.address} not opened`);
  const link = /^[0-9a-fA-F]{64}$/.test(linkOrAddress) ? linkOrAddress : nanocurrency.derivePublicKey(linkOrAddress);
  const blk = buildStateBlock(w.secretKey, {
    work: await work(info.frontier, SEND_DIFFICULTY),
    previous: info.frontier,
    representative: info.representative,
    balance: (BigInt(info.balance) - amountRaw).toString(),
    link,
  });
  const r = await nanoRpc(key, { action: "process", json_block: "true", subtype: "send", block: blk });
  return r.hash as string;
}

async function main() {
  const anchor = wallet(KEYS.anchorSeed);
  const test = wallet(KEYS.testSeed);
  const friend = wallet(KEYS.testSeed, 1); // fragment-transfer recipient

  console.log("1. open anchor + fund test wallet from it");
  await receiveAll(anchor);
  const ai = await accountInfo(anchor.address);
  console.log(`  anchor balance: ${ai?.balance ?? 0} raw`);
  const ti0 = await accountInfo(test.address);
  if (!ti0) {
    await send(anchor, test.address, 10n ** 25n); // 0.00001 XNO
    console.log("  funded test wallet with 1e25 raw");
  }
  await receiveAll(test);

  console.log("2. anchor hello from test wallet (discovery registration)");
  await send(test, ANCHOR_PUB, 1n);

  console.log("3. launch");
  const launch: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "E2E", symbol: "E2E", decimals: 6, image: "" };
  const launchHash = await send(test, encodeOpLink("", launch), 1n);
  const tokenId = tokenIdFromLaunchHash(launchHash);
  console.log(`  tokenId ${tokenId}`);

  if (!KEYS.testMasterSeed) {
    KEYS.testMasterSeed = require("node:crypto").randomBytes(32).toString("hex");
    fs.writeFileSync(".keys.json", JSON.stringify(KEYS, null, 2));
  }
  const pool = tokenPoolKeys(KEYS.testMasterSeed, tokenId);
  console.log(`  pool ${pool.address}`);

  console.log("4. seed: deposit 1e22 raw → compact seedLiq chained after it");
  await send(test, pool.publicKey, 10n ** 22n);
  await send(test, encodeOpLink(tokenId, { kind: "seedLiq", xno: 0n, tokens: 950_000_000_000n }), 1n);

  console.log("5. pool receives + self-registers (hello with tokenId rep)");
  await sleep(2000);
  await receivePoolPending(key, pool, tokenId);
  await ensurePoolHello(key, pool, tokenId);

  console.log("6. buy: deposit 1e21 raw → chained buy op");
  await send(test, pool.publicKey, 10n ** 21n);
  await send(test, encodeOpLink(tokenId, { kind: "buy", xno: 0n, minTokens: 0n }), 1n);
  await sleep(2000);
  await receivePoolPending(key, pool, tokenId);

  console.log("7. fragment sell (tokens=1e9, minXno=1) — payload fully on-chain");
  const [sa, sb] = encodeFragLinks(tokenId, { kind: "sell", tokens: 1_000_000_000n, minXno: 1n });
  await send(test, sa, 1n);
  await send(test, sb, 1n);

  console.log("8. fragment transfer (1e8 tokens → friend)");
  const [xa, xb] = encodeFragLinks(tokenId, { kind: "transfer", to: friend.address, amount: 100_000_000n });
  await send(test, xa, 1n);
  await send(test, xb, 1n);

  console.log("9. SECRETLESS indexer replay (no POOL_SEED, no commit blob)");
  await sleep(2000);
  const src = new NanoRpcSource(key);
  const idx = new MultiIndexer(src); // no meta, no commits, no poolKey
  const sync = await idx.sync([test.address, friend.address]);
  const s = idx.getState().get(tokenId);
  if (!s) throw new Error("token not found in replay");
  console.log(`  applied=${sync.applied} invalid=${sync.invalid} reasons=${sync.reasons.join("; ") || "none"}`);
  console.log(`  chain-derived pool: ${idx.getChainPools().get(tokenId)}`);
  console.log(`  poolXno=${s.poolXno} poolTokens=${s.poolTokens}`);
  console.log(`  creator tokens=${s.balances.get(test.address) ?? 0n} friend tokens=${s.balances.get(friend.address) ?? 0n}`);
  console.log(`  state root: ${stateRoot(idx.getState())}`);

  const checks: [string, boolean][] = [
    ["pool derived from chain matches custody pool", idx.getChainPools().get(tokenId) === pool.publicKey.toLowerCase()],
    ["seed + buy credited (poolXno > 1e22)", s.poolXno > 10n ** 22n],
    ["fragment transfer delivered", (s.balances.get(friend.address) ?? 0n) > 0n],
    ["no invalid ops", sync.invalid === 0],
  ];

  console.log("10. chain-derived settlement (pay the sell proceeds back)");
  const events = await idx.collectEvents([test.address, friend.address]);
  const { sellPayouts } = analyze(events);
  const credits = creditedBuys(events);
  const settle = await settlePoolNetted(key, pool, tokenId, sellPayouts, credits.get(tokenId) ?? new Map());
  console.log(`  paid=${settle.paid.length} queued=${settle.queued}`);
  const settle2 = await settlePoolNetted(key, pool, tokenId, sellPayouts, credits.get(tokenId) ?? new Map());
  console.log(`  re-run: paid=${settle2.paid.length} queued=${settle2.queued} (must be 0 — exactly-once from chain)`);
  checks.push(["settlement paid the seller", settle.paid.length >= 1]);
  checks.push(["settlement re-run pays nothing (no double-pay)", settle2.paid.length === 0]);

  console.log("11. discovery from the anchor (2-hop, no watch list)");
  const d = await discoverAccounts(src, ANCHOR_ADDRESS);
  console.log(`  users=${d.users.length} pools=${d.pools.size}`);
  checks.push(["test wallet discovered via hello", d.users.includes(test.address)]);
  checks.push(["pool self-registered with tokenId", d.pools.get(pool.address) === tokenId.toLowerCase()]);

  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "✅" : "❌"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\n✅ LIVE TRUSTLESS E2E PASSED" : "\n❌ LIVE TRUSTLESS E2E FAILED");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("live e2e failed:", e?.message ?? e);
  process.exit(1);
});
