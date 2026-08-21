// One-time migration onto anchor discovery (roadmap W7): send a 1-raw hello
// FROM the anchor TO each legacy WATCHED_ACCOUNTS entry, so accounts that
// predate the hello scheme become discoverable from chain data. After this
// (and pools self-registering via the sweep), WATCHED_ACCOUNTS can be deleted.
//
// Requires: anchorSeed in .keys.json (gitignored) and the anchor account
// opened with enough raw (1 per legacy account).
//
//   WATCHED_ACCOUNTS=nano_a,nano_b npx tsx scripts/anchor-bootstrap.ts

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";
import { nanoRpc, loadNanoRpcKey, SEND_DIFFICULTY } from "../lib/rpc";
import { buildStateBlock } from "../client/nano";
import { ANCHOR_ADDRESS } from "../core/anchor";

async function main() {
  const key = loadNanoRpcKey();
  const anchorSeed = JSON.parse(fs.readFileSync(".keys.json", "utf-8")).anchorSeed;
  if (!anchorSeed) throw new Error("anchorSeed missing from .keys.json");
  const secretKey = nanocurrency.deriveSecretKey(anchorSeed, 0);
  const address = nanocurrency.deriveAddress(nanocurrency.derivePublicKey(secretKey), { useNanoPrefix: true });
  if (address !== ANCHOR_ADDRESS) throw new Error(`anchorSeed derives ${address}, expected ${ANCHOR_ADDRESS}`);

  const targets = (process.env.WATCHED_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!targets.length) throw new Error("WATCHED_ACCOUNTS required (legacy accounts to bootstrap)");

  const info = await nanoRpc(key, { action: "account_info", account: ANCHOR_ADDRESS, representative: "true" });
  let frontier = info.frontier as string;
  let balance = BigInt(info.balance);
  // Skip accounts the anchor already sent to (idempotent re-runs).
  const hist = await nanoRpc(key, { action: "account_history", account: ANCHOR_ADDRESS, count: 1000 }).catch(() => ({ history: [] }));
  const alreadySent = new Set(
    ((hist.history ?? []) as { type: string; account: string }[]).filter((h) => h.type === "send").map((h) => h.account)
  );

  for (const target of targets) {
    if (alreadySent.has(target)) {
      console.log(`skip (already helloed): ${target}`);
      continue;
    }
    if (balance < 1n) throw new Error("anchor balance exhausted — fund it and re-run");
    const work = (await nanoRpc(key, { action: "work_generate", hash: frontier, difficulty: SEND_DIFFICULTY })).work;
    const blk = buildStateBlock(secretKey, {
      work,
      previous: frontier,
      representative: info.representative,
      balance: (balance - 1n).toString(),
      link: nanocurrency.derivePublicKey(target),
    });
    const r = await nanoRpc(key, { action: "process", json_block: "true", subtype: "send", block: blk });
    frontier = r.hash;
    balance -= 1n;
    console.log(`helloed ${target} (${r.hash.slice(0, 12)}…)`);
  }
  console.log("bootstrap complete — WATCHED_ACCOUNTS can be retired once pools have self-registered");
}

main().catch((e) => {
  console.error("bootstrap failed:", e?.message ?? e);
  process.exit(1);
});
