// Live value-bound buy e2e: deposit (native XNO send to the pool) + chained buy
// op (previous = deposit hash). Proves the indexer credits poolXno from the
// *deposit amount*, not any declared value.
//
//   NANO_RPC_KEY=... npm run buy-e2e

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { tokenPoolKeys } from "../server/custody";
import { receivePoolPending } from "../server/sweep";
import { MultiIndexer, metaMapResolver, commitMapResolver } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { encodeOpLink } from "../core/oplink";
import { commitLink } from "../core/commit";
import { tokenIdFromLaunchHash } from "../core/token";
import { loadNanoRpcKey, nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";

const SEED_XNO = "1000000000000000000000000000"; // 0.001 XNO
const BUY_XNO = "200000000000000000000000000"; // 0.0002 XNO

function buildBlock(secretKey: string, o: { work: string; previous: string | null; representative: string; balance: string; link: string }) {
  const b = nanocurrency.createBlock(secretKey, o);
  const blk: any = { ...b.block };
  blk.account = blk.account.replace(/^xrb_/, "nano_");
  delete blk.link_as_account;
  return blk;
}

async function info(key: string, address: string) {
  return nanoRpc(key, { action: "account_info", account: address, representative: "true" });
}

async function dataBlock(signer: any, previous: string, balance: bigint, rep: string, link: string, key: string) {
  const work = (await nanoRpc(key, { action: "work_generate", hash: previous, difficulty: SEND_DIFFICULTY })).work;
  const blk = buildBlock(signer.secretKey, { work, previous, representative: rep, balance: balance.toString(), link });
  const r = await nanoRpc(key, { action: "process", json_block: "true", block: blk });
  return r.hash as string;
}

async function main() {
  const key = loadNanoRpcKey();
  const creator = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
  const meta = { name: "Buy E2E", symbol: "BE2E", decimals: 6, image: "" };

  let ci = await info(key, creator.address);
  if (!ci.frontier) return console.log("fund first:", creator.address);
  if (BigInt(ci.balance) < BigInt(SEED_XNO) + BigInt(BUY_XNO) + 10n ** 24n) {
    return console.log("balance too low:", ci.balance);
  }

  const masterSeed = require("node:crypto").randomBytes(32).toString("hex");

  // 1. launch → tokenId
  const launchOp = { kind: "launch", supply: 1_000_000_000_000n, name: meta.name, symbol: meta.symbol, decimals: 6, image: "" };
  const launchHash = await dataBlock(creator, ci.frontier, BigInt(ci.balance) - 1n, ci.representative, encodeOpLink("", launchOp), key);
  const tokenId = tokenIdFromLaunchHash(launchHash);
  console.log("launched → tokenId", tokenId.slice(0, 12) + "…");
  const pool = tokenPoolKeys(masterSeed, tokenId);

  // 2. seedLiq: creator sends XNO to pool + commit op
  ci = await info(key, creator.address);
  const seedSend = await (async () => {
    const work = (await nanoRpc(key, { action: "work_generate", hash: ci.frontier, difficulty: SEND_DIFFICULTY })).work;
    const blk = buildBlock(creator.secretKey, { work, previous: ci.frontier, representative: ci.representative, balance: (BigInt(ci.balance) - BigInt(SEED_XNO)).toString(), link: pool.address });
    const r = await nanoRpc(key, { action: "process", json_block: "true", block: blk });
    return r.hash;
  })();
  const seedOp = { kind: "seedLiq" as const, xno: BigInt(SEED_XNO), tokens: 950_000_000_000n };
  ci = await info(key, creator.address);
  await dataBlock(creator, seedSend, BigInt(ci.balance) - 1n, ci.representative, commitLink(tokenId, seedOp), key);
  await receivePoolPending(key, pool);

  // 3. buy: deposit (XNO to pool) + chained buy op
  ci = await info(key, creator.address);
  const depositHash = await (async () => {
    const work = (await nanoRpc(key, { action: "work_generate", hash: ci.frontier, difficulty: SEND_DIFFICULTY })).work;
    const blk = buildBlock(creator.secretKey, { work, previous: ci.frontier, representative: ci.representative, balance: (BigInt(ci.balance) - BigInt(BUY_XNO)).toString(), link: pool.address });
    const r = await nanoRpc(key, { action: "process", json_block: "true", block: blk });
    return r.hash;
  })();
  const afterDeposit = await info(key, creator.address);
  await dataBlock(creator, depositHash, BigInt(afterDeposit.balance) - 1n, afterDeposit.representative, encodeOpLink(tokenId, { kind: "buy", xno: 0n, minTokens: 0n }), key);
  await receivePoolPending(key, pool);

  // 4. index with meta + commit + poolKey resolvers
  const poolKey = (id: string) => (id === tokenId ? pool.publicKey : null);
  const idx = new MultiIndexer(new NanoRpcSource(key), metaMapResolver(new Map([[tokenId, meta]])), commitMapResolver([{ tokenId, op: seedOp }]), poolKey);
  const sync = await idx.sync([creator.address]);
  const s = idx.getState().get(tokenId);

  if (!s || !s.launched) return console.log("❌ BUY E2E FAILED (token missing)");
  const expected = BigInt(SEED_XNO) + BigInt(BUY_XNO);
  console.log("indexed:", sync.applied, "applied", sync.invalid, "invalid");
  console.log("poolXno:", s.poolXno.toString(), "expected ≥", expected.toString());
  console.log("creator tokens:", (s.balances.get(creator.address) ?? 0n).toString());

  const ok = s.poolXno >= expected && (s.balances.get(creator.address) ?? 0n) > 50_000_000_000n;
  console.log(ok ? "\n✅ VALUE-BOUND BUY E2E PASSED" : "\n❌ VALUE-BOUND BUY E2E FAILED");
}

main().catch((e) => {
  console.error("buy e2e failed:", e);
  process.exit(1);
});