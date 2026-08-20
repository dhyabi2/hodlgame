// End-to-end Nano block test: open a funded account, then broadcast L2 data
// blocks (launch / buy / stake / unstake / sell) as real Nano state blocks,
// confirm them, read them back, and replay them into the deterministic token
// state.
//
//   cd nano && npm run e2e-blocks
//
// Requires `.keys.json` (account + nanoRpcKey) and a pending incoming amount.

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { opCommitment } from "../core/encoding";
import type { Op } from "../core/ops";
import { replay } from "../indexer/replay";

const RPC = process.env.NANO_RPC ?? "https://rpc.nano.to";

interface Keys {
  seed: string;
  secretKey: string;
  publicKey: string;
  address: string;
  nanoRpcKey?: string;
}

const RAW_01_XNO = "100000000000000000000000000000"; // 0.1 XNO in raw

async function rpc(key: string | undefined, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(String(json.error));
  return json;
}

async function work(key: string | undefined, hash: string): Promise<string> {
  const r = await rpc(key, { action: "work_generate", hash });
  return r.work as string;
}

async function main() {
  const keys: Keys = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
  const key = keys.nanoRpcKey;
  console.log("Account:", keys.address, "| RPC:", RPC);

  let info: any;
  try {
    info = await rpc(key, { action: "account_info", account: keys.address, representative: true, pending: true });
  } catch (e) {
    // "Account not found" = not opened yet.
    info = {};
  }

  // 1. Open the account if it has no frontier (needs a pending receive).
  let frontier: string;
  let balance = RAW_01_XNO;
  if (!info.frontier) {
    const pending = await rpc(key, { action: "pending", account: keys.address, count: 1 });
    const blocks: string[] = pending.blocks ?? [];
    if (blocks.length === 0) {
      console.log("\nNo pending funds yet. Fund this address, then re-run:");
      console.log("  ", keys.address);
      return;
    }
    const w = await work(key, keys.publicKey);
    const open = nanocurrency.createBlock(keys.secretKey, {
      work: w,
      previous: null,
      representative: keys.address,
      balance: RAW_01_XNO,
      link: blocks[0],
    });
    const r = await rpc(key, { action: "process", block: open.block });
    frontier = r.hash;
    console.log("Opened account:", frontier);
  } else {
    frontier = info.frontier;
    balance = info.balance;
  }

  // 2. Broadcast L2 data blocks (each carries an op commitment in `link`).
  const ops: { op: Op; label: string }[] = [
    { op: { kind: "launch", supply: 1_000_000_000_000n, name: "E2E Coin", symbol: "E2E", decimals: 6, image: "" }, label: "launch" },
    { op: { kind: "buy", xno: 10n ** 28n, minTokens: 0n }, label: "buy" },
    { op: { kind: "stake", amount: 50_000_000_000n }, label: "stake" },
    { op: { kind: "unstake", amount: 10_000_000_000n }, label: "unstake" },
    { op: { kind: "sell", tokens: 5_000_000_000n, minXno: 0n }, label: "sell" },
  ];

  const sent: { sender: string; op: Op; hash: string }[] = [];
  for (const { op, label } of ops) {
    const link = opCommitment(op);
    const w = await work(key, frontier);
    const blk = nanocurrency.createBlock(keys.secretKey, {
      work: w,
      previous: frontier,
      representative: keys.address,
      balance,
      link,
    });
    const r = await rpc(key, { action: "process", block: blk.block });
    frontier = r.hash;
    console.log(`Broadcast ${label.padEnd(8)} -> ${frontier.slice(0, 12)}…`);
    sent.push({ sender: keys.address, op, hash: frontier });
  }

  // 3. Read back and replay into token state.
  const hist = await rpc(key, { action: "account_history", account: keys.address, count: 20, raw: true });
  const history = (hist.history ?? []) as { hash: string; height: string }[];
  const heightOf = new Map(history.map((h) => [h.hash, BigInt(h.height)]));
  const events = sent.map((s) => ({
    sender: s.sender,
    op: s.op,
    height: heightOf.get(s.hash) ?? 0n,
  }));

  const { state, invalid } = replay(events);
  console.log("\nReplayed token state:");
  console.log("  launched:", state.launched, "| supply:", state.supply.toString());
  console.log("  creatorShare:", state.creatorShare.toString(), "(5% of 1e12)");
  console.log("  invalid ops:", invalid.length);

  console.log("\n✅ Nano block e2e complete (", sent.length, "blocks confirmed)");
}

main().catch((e) => {
  console.error("e2e failed:", e);
  process.exit(1);
});
