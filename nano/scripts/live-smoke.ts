// Live smoke test: read a real Nano account's history through NanoRpcSource.
// Proves the indexer's block source works against a public Nano node.
// (Not part of `npm test` — it needs network.)

import { NanoRpcSource } from "../indexer/blockSource";

const GENESIS = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

async function main() {
  const endpoint = process.env.NANO_RPC ?? "https://rpc.nano.to";
  const source = new NanoRpcSource(endpoint);
  console.log("Reading blocks for", GENESIS, "via", endpoint);
  const blocks = await source.listBlocks(GENESIS, 5);
  console.log("Got", blocks.length, "blocks");
  for (const b of blocks) {
    console.log(`  ${b.hash.slice(0, 12)}… h=${b.height} rep=${b.representative.slice(0, 16)}… link=${b.link.slice(0, 12)}…`);
  }
  if (blocks.length > 0) console.log("✅ NanoRpcSource works against a live node");
  else console.log("⚠ No blocks returned (account may be empty or RPC rate-limited)");
}

main().catch((e) => {
  console.error("live smoke failed:", e);
  process.exit(1);
});
