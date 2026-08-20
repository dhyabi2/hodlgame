// Live sell-payout e2e: seed a pool, sell tokens, and verify XNO actually
// moves pool -> user through the custody sweep.
//
//   NANO_RPC_KEY=... npm run sell-e2e

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { poolKeysFromSeed } from "../server/custody";
import { receivePoolPending, payoutSells } from "../server/sweep";
import { replayState } from "../server/indexer";
import { encodeOpCompact } from "../core/compact";
import { loadNanoRpcKey, nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";

const SEED_XNO = "1000000000000000000000000000"; // 0.001 XNO raw

async function main() {
  const key = loadNanoRpcKey();
  const creator = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
  const meta = { name: "HoldFun", symbol: "HOLD", decimals: 6, image: "" };

  // 1. Fresh pool.
  const pool = poolKeysFromSeed(require("node:crypto").randomBytes(32).toString("hex"));
  console.log("pool:", pool.address);

  // 2. Creator sends XNO to the pool (seedLiq XNO side).
  let info = await nanoRpc(key, { action: "account_info", account: creator.address, representative: "true" });
  const work1 = (await nanoRpc(key, { action: "work_generate", hash: info.frontier, difficulty: SEND_DIFFICULTY })).work;
  const sendBlk = nanocurrency.createBlock(creator.secretKey, {
    work: work1, previous: info.frontier, representative: info.representative,
    balance: (BigInt(info.balance) - BigInt(SEED_XNO)).toString(), link: pool.address,
  });
  const sb: any = { ...sendBlk.block }; sb.account = sb.account.replace(/^xrb_/, "nano_"); delete sb.link_as_account;
  await nanoRpc(key, { action: "process", json_block: "true", block: sb });
  console.log("creator sent", SEED_XNO, "raw XNO to pool");

  // 3. seedLiq op (carries the token side).
  await op(creator, { kind: "seedLiq", xno: BigInt(SEED_XNO), tokens: 950_000_000_000n }, "seedLiq", key);

  // 4. Pool accepts the XNO (buy/custody receive).
  const received = await receivePoolPending(key, pool);
  console.log("pool received:", received.length, "block(s)");

  // 5. Sell some of the creator's 5% back.
  await op(creator, { kind: "sell", tokens: 1_000_000_000n, minXno: 0n }, "sell", key);

  // 6. Sweep: pay out the sell.
  const { paid, skipped } = await payoutSells(key, pool, meta, [creator.address]);
  const pending = await nanoRpc(key, { action: "pending", account: creator.address, count: 10, source: true });

  console.log("sell payouts broadcast:", paid.length, "(skipped:", skipped + ")");
  console.log("creator pending (XNO from pool):", JSON.stringify(pending.blocks ?? {}));

  const { state } = await replayState(key, meta, [creator.address]);
  console.log("state: supply", state.supply.toString(), "| poolXno", state.poolXno.toString(), "| poolTokens", state.poolTokens.toString());

  // The payout is a pool -> creator send; it lands as a pending amount.
  const got = Object.values(pending.blocks ?? {}).some(
    (b: any) => b.source === pool.address && BigInt(b.amount) > 0n
  );
  console.log(got ? "\n✅ SELL PAYOUT E2E PASSED" : "\n❌ SELL PAYOUT FAILED");
}

async function op(creator: any, o: any, label: string, key: string) {
  const info = await nanoRpc(key, { action: "account_info", account: creator.address, representative: "true" });
  const link = encodeOpCompact(o);
  const work = (await nanoRpc(key, { action: "work_generate", hash: info.frontier, difficulty: SEND_DIFFICULTY })).work;
  const b = nanocurrency.createBlock(creator.secretKey, {
    work, previous: info.frontier, representative: info.representative,
    balance: (BigInt(info.balance) - 1n).toString(), link,
  });
  const blk: any = { ...b.block }; blk.account = blk.account.replace(/^xrb_/, "nano_"); delete blk.link_as_account;
  const r = await nanoRpc(key, { action: "process", json_block: "true", block: blk });
  console.log(`  ${label} → ${r.hash.slice(0, 10)}…`);
}

main().catch((e) => {
  console.error("sell e2e failed:", e);
  process.exit(1);
});
