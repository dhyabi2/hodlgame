// Anyone-can-verify: recompute the entire market state from chain data and
// print its consensus root — WITHOUT POOL_SEED. Pool accounts are derived
// from chain history (each token's first creator-signed seed deposit names
// its pool), so verification needs no custody secrets.
//
//   WATCHED_ACCOUNTS=nano_a,nano_b npx tsx scripts/verify.ts [--url http://indexer:8080]
//
// With --url, the recomputed root is diffed against the serving indexer's
// /root endpoint: exit 0 VERIFIED, exit 1 MISMATCH.
//
// Current inputs beyond the chain: the commit-reveal registry and metadata
// registry (local store or public mirror) — these go fully on-chain /
// mirror-verified in roadmap workstreams W3/W4 (docs/TRUSTLESS-ROADMAP.md).

import { MultiIndexer, metaMapResolver } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { commitResolver } from "../server/commits";
import { loadRegistry } from "../server/tokens";
import { stateRoot } from "../core/canonical";
import { balanceRoot } from "../core/merkle";
import { loadNanoRpcKey } from "../lib/rpc";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const accounts = (process.env.WATCHED_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (accounts.length === 0) {
    console.error("WATCHED_ACCOUNTS required (comma-separated nano_ accounts to replay)");
    process.exit(2);
  }

  const reg = await loadRegistry();
  const commit = await commitResolver();
  // NOTE: no poolKey resolver — pools resolve from chain history alone.
  const idx = new MultiIndexer(new NanoRpcSource(loadNanoRpcKey()), metaMapResolver(reg), commit);
  const { applied, invalid } = await idx.sync(accounts);
  const state = idx.getState();
  const root = stateRoot(state);

  console.log(`replayed ${applied} ops (${invalid} invalid) across ${state.size} token(s)`);
  for (const [tokenId, s] of state) {
    console.log(
      `  ${tokenId.slice(0, 12)}…  supply=${s.supply}  poolXno=${s.poolXno}  poolTokens=${s.poolTokens}  holders=${s.balances.size}`
    );
  }
  console.log(`state root:   ${root}`);
  // Establish the balance root from YOUR OWN replay so light Merkle balance
  // proofs (exchange kit) verify against a root you derived, never a
  // server-supplied one (see core/merkle.ts trust model).
  console.log(`balance root: ${balanceRoot(state)}`);

  const url = arg("--url");
  if (url) {
    const res = await fetch(`${url.replace(/\/$/, "")}/root`);
    const j = (await res.json()) as { root?: string };
    if (!j.root) {
      console.error("serving indexer returned no root");
      process.exit(2);
    }
    if (j.root.toLowerCase() === root.toLowerCase()) {
      console.log(`VERIFIED — serving indexer agrees (${url})`);
    } else {
      console.error(`MISMATCH — serving indexer root ${j.root} != recomputed ${root}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("verify failed:", e?.message ?? e);
  process.exit(2);
});
