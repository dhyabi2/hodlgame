// Export (and optionally anchor) an epoch snapshot of the residual off-chain
// state — see server/snapshot.ts. The snapshot file can be mirrored anywhere
// untrusted; the on-chain anchor makes it verifiable.
//
//   npx tsx scripts/snapshot.ts                # export → snapshot-<hash8>.json
//   npx tsx scripts/snapshot.ts --anchor       # also burn 1 raw from the anchor
//                                              # account to <hash> (needs
//                                              # anchorSeed in .keys.json)

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { exportSnapshot, isAnchored } from "../server/snapshot";
import { nanoRpc, loadNanoRpcKey, SEND_DIFFICULTY } from "../lib/rpc";
import { buildStateBlock } from "../client/nano";
import { ANCHOR_ADDRESS } from "../core/anchor";
import { NanoRpcSource } from "../indexer/blockSource";

async function main() {
  const snap = await exportSnapshot();
  const file = `snapshot-${snap.hash.slice(0, 8)}.json`;
  fs.writeFileSync(file, snap.json);
  console.log(`exported ${file} (${snap.json.length} bytes)`);
  console.log(`hash: ${snap.hash}`);

  if (!process.argv.includes("--anchor")) return;

  const key = loadNanoRpcKey();
  const blocks = await new NanoRpcSource(key).listBlocks(ANCHOR_ADDRESS);
  if (isAnchored(blocks, snap.hash)) {
    console.log("already anchored on-chain — nothing to do");
    return;
  }
  const anchorSeed = JSON.parse(fs.readFileSync(".keys.json", "utf-8")).anchorSeed;
  if (!anchorSeed) throw new Error("anchorSeed missing from .keys.json");
  const secretKey = nanocurrency.deriveSecretKey(anchorSeed, 0);
  const info = await nanoRpc(key, { action: "account_info", account: ANCHOR_ADDRESS, representative: "true" });
  if (BigInt(info.balance) < 1n) throw new Error("anchor account needs at least 1 raw");
  const work = (await nanoRpc(key, { action: "work_generate", hash: info.frontier, difficulty: SEND_DIFFICULTY })).work;
  const blk = buildStateBlock(secretKey, {
    work,
    previous: info.frontier,
    representative: info.representative,
    balance: (BigInt(info.balance) - 1n).toString(),
    link: snap.hash, // destination pubkey IS the snapshot hash (data-anchor burn)
  });
  const r = await nanoRpc(key, { action: "process", json_block: "true", subtype: "send", block: blk });
  console.log(`anchored on-chain: ${r.hash}`);
}

main().catch((e) => {
  console.error("snapshot failed:", e?.message ?? e);
  process.exit(1);
});
