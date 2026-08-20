// Live multi-token e2e: launch → seedLiq (commit-reveal) → sell → per-token
// custody payout. Proves the whole multi-token stack (tokenId derivation, op-link
// + commit codecs, per-token pool key, per-token sell payout) against mainnet.
//
//   NANO_RPC_KEY=... npm run multitoken-e2e

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { tokenPoolKeys } from "../server/custody";
import { receivePoolPending, payoutSellsMulti } from "../server/sweep";
import { MultiIndexer, metaMapResolver, commitMapResolver } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { encodeOpLink } from "../core/oplink";
import { commitLink } from "../core/commit";
import { tokenIdFromLaunchHash } from "../core/token";
import { analyze } from "../server/analytics";
import { loadNanoRpcKey, nanoRpc, SEND_DIFFICULTY } from "../lib/rpc";

const SEED_XNO = "1000000000000000000000000000"; // 0.001 XNO raw

function buildBlock(
  secretKey: string,
  opts: { work: string; previous: string | null; representative: string; balance: string; link: string }
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

async function accountInfo(key: string, address: string) {
  return nanoRpc(key, { action: "account_info", account: address, representative: "true" });
}

/** Broadcast a data block (spend 1 raw) carrying `link`; returns the block hash. */
async function op(signer: any, link: string, key: string): Promise<string> {
  const info = await accountInfo(key, signer.address);
  const work = (await nanoRpc(key, { action: "work_generate", hash: info.frontier, difficulty: SEND_DIFFICULTY })).work;
  const blk = buildBlock(signer.secretKey, {
    work,
    previous: info.frontier,
    representative: info.representative,
    balance: (BigInt(info.balance) - 1n).toString(),
    link,
  });
  const r = await nanoRpc(key, { action: "process", json_block: "true", block: blk });
  return r.hash as string;
}

/** Send XNO to a recipient account. */
async function sendXno(signer: any, to: string, amountRaw: string, key: string): Promise<string> {
  const info = await accountInfo(key, signer.address);
  const work = (await nanoRpc(key, { action: "work_generate", hash: info.frontier, difficulty: SEND_DIFFICULTY })).work;
  const blk = buildBlock(signer.secretKey, {
    work,
    previous: info.frontier,
    representative: info.representative,
    balance: (BigInt(info.balance) - BigInt(amountRaw)).toString(),
    link: to,
  });
  const r = await nanoRpc(key, { action: "process", json_block: "true", block: blk });
  return r.hash as string;
}

async function main() {
  const key = loadNanoRpcKey();
  const creator = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
  const meta = { name: "Multi E2E", symbol: "ME2E", decimals: 6, image: "" };

  const info0 = await accountInfo(key, creator.address);
  if (!info0.frontier) {
    console.log("Fund this account first, then re-run:", creator.address);
    return;
  }
  if (BigInt(info0.balance) < BigInt(SEED_XNO) + 10n ** 24n) {
    console.log("Creator balance too low:", info0.balance, "(need >", SEED_XNO + ")");
    return;
  }

  const masterSeed = require("node:crypto").randomBytes(32).toString("hex");

  // 1. launch (compact op; tokenId is derived from the block hash after broadcast).
  const launchOp = { kind: "launch", supply: 1_000_000_000_000n, name: meta.name, symbol: meta.symbol, decimals: 6, image: "" };
  const launchHash = await op(creator, encodeOpLink("", launchOp), key);
  const tokenId = tokenIdFromLaunchHash(launchHash);
  console.log("launch", launchHash.slice(0, 10) + "…", "→ tokenId", tokenId.slice(0, 12) + "…");

  const pool = tokenPoolKeys(masterSeed, tokenId);
  console.log("token pool", pool.address.slice(0, 16) + "…");

  // 2. seedLiq: creator sends XNO to the token pool + a commit-reveal op.
  await sendXno(creator, pool.address, SEED_XNO, key);
  const seedOp = { kind: "seedLiq" as const, xno: BigInt(SEED_XNO), tokens: 950_000_000_000n };
  await op(creator, commitLink(tokenId, seedOp), key);
  console.log("seedLiq committed (XNO sent + commit op)");

  // 3. accept the XNO into the token's own pool account.
  const received = await receivePoolPending(key, pool);
  console.log("pool received:", received.length, "block(s)");

  // 4. sell the creator's 5% back (compact op with tokenId).
  await op(creator, encodeOpLink(tokenId, { kind: "sell", tokens: 1_000_000_000n, minXno: 0n }), key);

  // 5. index with per-token meta + commit resolvers.
  const idx = new MultiIndexer(
    new NanoRpcSource(key),
    metaMapResolver(new Map([[tokenId, meta]])),
    commitMapResolver([{ tokenId, op: seedOp }])
  );
  const sync = await idx.sync([creator.address]);
  console.log("indexed:", sync.applied, "applied,", sync.invalid, "invalid", sync.reasons.length ? "(" + sync.reasons.join(", ") + ")" : "");

  const s = idx.getState().get(tokenId);
  if (!s || !s.launched) {
    console.log("❌ MULTI-TOKEN E2E FAILED (token not in MultiState)");
    return;
  }
  console.log("state:", s.name, "supply", s.supply.toString(), "poolXno", s.poolXno.toString(), "poolTokens", s.poolTokens.toString());

  // 6. per-token payout (exact XNO-out from the deterministic replay).
  const events = await idx.collectEvents([creator.address]);
  const { sellPayouts } = analyze(events);
  const { paid, skipped } = await payoutSellsMulti(key, masterSeed, sellPayouts, []);
  console.log("sell payouts broadcast:", paid.length, "(skipped:", skipped + ")");

  const pending = await nanoRpc(key, { action: "pending", account: creator.address, count: 50, source: true });
  const got = Object.values(pending.blocks ?? {}).some(
    (b: any) => b.source === pool.address && BigInt(b.amount) > 0n
  );

  console.log(got ? "\n✅ MULTI-TOKEN E2E PASSED" : "\n❌ MULTI-TOKEN E2E FAILED");
}

main().catch((e) => {
  console.error("multi-token e2e failed:", e);
  process.exit(1);
});