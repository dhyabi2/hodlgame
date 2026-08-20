// Live smoke test: read a real Nano account's history through NanoRpcSource
// (rpc.nano.to only). Proves the indexer's block source works against the live
// network. (Not part of `npm test` — it needs network.)

import { NanoRpcSource } from "../indexer/blockSource";
import { NANO_RPC, loadNanoRpcKey } from "../lib/rpc";

const GENESIS = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

async function main() {
  const key = loadNanoRpcKey();
  console.log("Reading blocks for", GENESIS, "via", NANO_RPC);
  const source = new NanoRpcSource(key);
  const blocks = await source.listBlocks(GENESIS, 5);
  console.log("Got", blocks.length, "blocks");
  for (const b of blocks) {
    console.log(`  ${b.hash.slice(0, 12)}… h=${b.height} link=${b.link.slice(0, 12)}…`);
  }
  if (blocks.length > 0) console.log("✅ NanoRpcSource works against rpc.nano.to");
  else console.log("⚠ No blocks returned");
}

main().catch((e) => {
  console.error("live smoke failed:", e);
  process.exit(1);
});
