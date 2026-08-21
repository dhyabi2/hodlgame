// Migrate a token's pool custody from single-key POOL_SEED to a FROST group
// address — the HoldFun analogue of VELA's scripts/migrate_pool.py, using the
// pool-rotation mechanism (core/rotate.ts). Signed by the CURRENT (POOL_SEED)
// pool key: it announces the successor on-chain, then sweeps the balance over.
// After this, the resolver treats the FROST address as current; the old
// address stays LEGACY so historical deposits still value-bind, and the FROST
// group receives the swept funds via its own signing.
//
//   POOL_SEED=<64hex> npx tsx scripts/frost-migrate.ts <tokenId> <newPoolPubHex> [--dry-run]
//
// Idempotent: re-running skips an already-announced rotation and an
// already-swept balance. Never destroys POOL_SEED — keep it offline until you
// have confirmed the FROST balances, then destroy it.

import * as nanocurrency from "nanocurrency";
import { nanoRpc, loadNanoRpcKey, SEND_DIFFICULTY } from "../lib/rpc";
import { buildStateBlock } from "../client/nano";
import { tokenPoolKeys } from "../server/custody";
import { rotateMarkerAddress, isRotateRep } from "../core/rotate";
import { NanoRpcSource } from "../indexer/blockSource";

async function main() {
  const [tokenId, newPoolPub] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");
  const master = process.env.POOL_SEED;
  if (!master) throw new Error("POOL_SEED required");
  if (!/^[0-9a-fA-F]{32}$/.test(tokenId ?? "")) throw new Error("tokenId (32 hex) required");
  if (!/^[0-9a-fA-F]{64}$/.test(newPoolPub ?? "")) throw new Error("newPoolPub (64 hex) required");

  const key = loadNanoRpcKey();
  const old = tokenPoolKeys(master, tokenId);
  const newAddr = nanocurrency.deriveAddress(newPoolPub.toLowerCase(), { useNanoPrefix: true });
  console.log(`migrating ${tokenId.slice(0, 12)}…: ${old.address} → ${newAddr}`);

  // 1. Announce the rotation (skip if already on the old pool's chain).
  const src = new NanoRpcSource(key);
  const blocks = await src.listBlocks(old.address);
  const already = blocks.some((b) => isRotateRep(b.representative) && b.link.toLowerCase() === newPoolPub.toLowerCase());
  const info = () => nanoRpc(key, { action: "account_info", account: old.address, representative: "true" });

  if (already) {
    console.log("rotation already announced ✓");
  } else if (dryRun) {
    console.log("[dry-run] would announce rotation");
  } else {
    const i = await info();
    if (!i?.frontier) throw new Error("old pool not opened / empty");
    const work = (await nanoRpc(key, { action: "work_generate", hash: i.frontier, difficulty: SEND_DIFFICULTY })).work;
    const blk = buildStateBlock(old.secretKey, {
      work,
      previous: i.frontier,
      representative: rotateMarkerAddress(),
      balance: (BigInt(i.balance) - 1n).toString(),
      link: newPoolPub.toLowerCase(),
    });
    const r = await nanoRpc(key, { action: "process", json_block: "true", subtype: "send", block: blk });
    console.log(`announced rotation ✓ ${r.hash.slice(0, 12)}…`);
  }

  // 2. Sweep the remaining balance old → new (skip if dust).
  const i2 = await info();
  const bal = BigInt(i2?.balance ?? "0");
  if (bal <= 1n) {
    console.log("old pool already drained ✓");
  } else if (dryRun) {
    console.log(`[dry-run] would sweep ${bal} raw → ${newAddr}`);
  } else {
    const work = (await nanoRpc(key, { action: "work_generate", hash: i2.frontier, difficulty: SEND_DIFFICULTY })).work;
    const blk = buildStateBlock(old.secretKey, {
      work,
      previous: i2.frontier,
      representative: i2.representative,
      balance: "0",
      link: newPoolPub.toLowerCase(),
    });
    const r = await nanoRpc(key, { action: "process", json_block: "true", subtype: "send", block: blk });
    console.log(`swept ${bal} raw → FROST pool ✓ ${r.hash.slice(0, 12)}…`);
    console.log("The FROST group must now RECEIVE it (its own signing) and hello to self-register.");
  }

  console.log("done. Keep POOL_SEED offline until FROST balances are confirmed, then destroy it.");
}

main().catch((e) => {
  console.error("migration failed:", e?.message ?? e);
  process.exit(1);
});
