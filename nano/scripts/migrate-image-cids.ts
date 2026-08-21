// One-time migration: rewrite stored token images from gateway URLs
// (https://<any>/ipfs/CID) to host-independent ipfs://CID. Safe to re-run;
// non-IPFS URLs are left alone. The web client resolves both forms, so this
// is an optimization, not a prerequisite.
//
//   npx tsx scripts/migrate-image-cids.ts

import { loadJson, saveJson } from "../server/store";

async function main() {
  const raw = (await loadJson<Record<string, any>>("tokens")) ?? {};
  let changed = 0;
  for (const [id, row] of Object.entries(raw)) {
    const m = String(row?.image ?? "").match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?$/);
    if (!m) continue;
    row.image = `ipfs://${m[1]}${m[2] ?? ""}`;
    changed++;
    console.log(`${id.slice(0, 12)}… → ${row.image}`);
  }
  if (changed) await saveJson("tokens", raw);
  console.log(changed ? `migrated ${changed} image(s)` : "nothing to migrate");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
