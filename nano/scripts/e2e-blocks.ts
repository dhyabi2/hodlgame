// End-to-end Nano test (rpc.nano.to only): open a funded account, then
// broadcast L2 data blocks (launch / buy / stake / unstake / sell), confirm
// them, read them back, and replay into the deterministic token state.
//
//   cd nano && npm run e2e-blocks

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { opCommitment } from "../core/encoding";
import type { Op } from "../core/ops";
import { replay } from "../indexer/replay";
import { NANO_RPC, loadNanoRpcKey, nanoRpc } from "../lib/rpc";

const RAW_01_XNO = "100000000000000000000000000000"; // 0.1 XNO in raw

interface Keys {
  seed: string;
  secretKey: string;
  publicKey: string;
  address: string;
  nanoRpcKey?: string;
}

// Work generation: prefer server-side GPU PoW (rpc.nano.to work_generate);
// fall back to client-side computeWork if the tier doesn't include it.
async function getWork(key: string, hash: string): Promise<string> {
  try {
    const r = await nanoRpc(key, { action: "work_generate", hash });
    return r.work as string;
  } catch {
    return nanocurrency.computeWork(hash);
  }
}

async function main() {
  const keys: Keys = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
  const key = loadNanoRpcKey();
  console.log("Account:", keys.address, "| RPC:", NANO_RPC);

  let info: any;
  try {
    info = await nanoRpc(key, { action: "account_info", account: keys.address, representative: true, pending: true });
  } catch {
    info = {};
  }

  // 1. Open the account (receive the pending funds).
  let frontier: string;
  let balance = RAW_01_XNO;
  if (!info.frontier) {
    const pending = await nanoRpc(key, { action: "pending", account: keys.address, count: 1 });
    const blocks: string[] = pending.blocks ?? [];
    if (blocks.length === 0) {
      console.log("\nNo pending funds yet. Fund this address, then re-run:");
      console.log("  ", keys.address);
      return;
    }
    const work = await getWork(key, keys.publicKey);
    const open = nanocurrency.createBlock(keys.secretKey, {
      work,
      previous: null,
      representative: keys.address,
      balance: RAW_01_XNO,
      link: blocks[0],
    });
    const blk: any = { ...open.block };
    blk.account = blk.account.replace(/^xrb_/, "nano_");
    blk.link_as_account = "0";
    const r = await nanoRpc(key, { action: "process", block: blk });
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
    const work = await getWork(key, frontier);
    const blk = nanocurrency.createBlock(keys.secretKey, {
      work,
      previous: frontier,
      representative: keys.address,
      balance,
      link,
    });
    const b: any = { ...blk.block };
    b.account = b.account.replace(/^xrb_/, "nano_");
    b.link_as_account = "0";
    const r = await nanoRpc(key, { action: "process", block: b });
    frontier = r.hash;
    console.log(`Broadcast ${label.padEnd(8)} -> ${frontier.slice(0, 12)}…`);
    sent.push({ sender: keys.address, op, hash: frontier });
  }

  // 3. Read back and replay.
  const hist = await nanoRpc(key, { action: "account_history", account: keys.address, count: 20, raw: true });
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

  console.log("\n✅ Nano e2e complete (", sent.length, "blocks confirmed)");
}

main().catch((e) => {
  console.error("e2e failed:", e);
  process.exit(1);
});
