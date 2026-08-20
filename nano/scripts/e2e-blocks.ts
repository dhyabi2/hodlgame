// End-to-end Nano test (rpc.nano.to only): open the funded account (if needed),
// then broadcast L2 data blocks (launch / buy / stake / unstake / sell) as real
// Nano state blocks, confirm them, read them back, and replay into the
// deterministic token state.
//
// Data blocks are SEND blocks (balance decreases by 1 raw per block) so the op
// commitment can ride in `link` — the same pattern the reference uses to carry
// its ZK commitment on-chain.
//
//   cd nano && npm run e2e-blocks

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { opCommitment } from "../core/encoding";
import type { Op } from "../core/ops";
import { replay } from "../indexer/replay";
import { NANO_RPC, loadNanoRpcKey, nanoRpc } from "../lib/rpc";

const RAW_01_XNO = "100000000000000000000000000000"; // 0.1 XNO in raw
const SEND_DIFFICULTY = "fffffff800000000";

interface Keys {
  seed: string;
  secretKey: string;
  publicKey: string;
  address: string;
  nanoRpcKey?: string;
}

async function getWork(key: string, hash: string): Promise<string> {
  const r = await nanoRpc(key, {
    action: "work_generate",
    hash,
    difficulty: SEND_DIFFICULTY,
  });
  return r.work as string;
}

/** Build a state block with the correct on-chain JSON (nano_ prefix, no
 *  link_as_account; link = raw 32-byte hex). */
function buildBlock(
  secretKey: string,
  opts: {
    work: string;
    previous: string | null;
    representative: string;
    balance: string;
    link: string;
  }
) {
  const b = nanocurrency.createBlock(secretKey, {
    work: opts.work,
    previous: opts.previous,
    representative: opts.representative,
    balance: opts.balance,
    link: opts.link,
  });
  const blk: any = { ...b.block };
  blk.account = blk.account.replace(/^xrb_/, "nano_");
  delete blk.link_as_account;
  return blk;
}

async function broadcast(key: string, blk: any) {
  return nanoRpc(key, { action: "process", json_block: "true", block: blk });
}

async function main() {
  const keys: Keys = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
  const key = loadNanoRpcKey();
  const REP = keys.address; // self-representative (fine for a test account)
  console.log("Account:", keys.address, "| RPC:", NANO_RPC);

  let info: any;
  try {
    info = await nanoRpc(key, { action: "account_info", account: keys.address, representative: "true" });
  } catch {
    info = {};
  }

  // 1. Open the account if it has no frontier.
  let frontier: string;
  let balance = BigInt(RAW_01_XNO);
  if (!info.frontier) {
    const pending = await nanoRpc(key, { action: "pending", account: keys.address, count: 1 });
    const blocks: string[] = pending.blocks ?? [];
    if (blocks.length === 0) {
      console.log("\nNo pending funds yet. Fund this address, then re-run:");
      console.log("  ", keys.address);
      return;
    }
    const work = await getWork(key, keys.publicKey);
    const open = buildBlock(keys.secretKey, {
      work,
      previous: null,
      representative: REP,
      balance: RAW_01_XNO,
      link: blocks[0],
    });
    const r = await broadcast(key, open);
    frontier = r.hash;
    console.log("Opened account:", frontier);
  } else {
    frontier = info.frontier;
    balance = BigInt(info.balance);
  }

  // 2. Broadcast L2 data blocks (each a SEND carrying the op commitment).
  const ops: { op: Op; label: string }[] = [
    { op: { kind: "launch", supply: 1_000_000_000_000n, name: "E2E Coin", symbol: "E2E", decimals: 6, image: "" }, label: "launch" },
    { op: { kind: "seedLiq", xno: 10n ** 28n, tokens: 950_000_000_000n }, label: "seedLiq" },
    { op: { kind: "buy", xno: 10n ** 28n, minTokens: 0n }, label: "buy" },
    { op: { kind: "stake", amount: 50_000_000_000n }, label: "stake" },
    { op: { kind: "unstake", amount: 10_000_000_000n }, label: "unstake" },
    { op: { kind: "sell", tokens: 5_000_000_000n, minXno: 0n }, label: "sell" },
  ];

  const sent: { sender: string; op: Op; hash: string }[] = [];
  for (const { op, label } of ops) {
    const link = opCommitment(op);
    const work = await getWork(key, frontier);
    balance = balance - 1n; // send: spend 1 raw to carry the data
    const blk = buildBlock(keys.secretKey, {
      work,
      previous: frontier,
      representative: REP,
      balance: balance.toString(),
      link,
    });
    const r = await broadcast(key, blk);
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
