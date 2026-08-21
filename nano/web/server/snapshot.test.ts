import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "holdfun-snap-"));

import { saveJson } from "./store";
import { exportSnapshot, verifySnapshotJson, isAnchored } from "./snapshot";
import type { NanoBlock } from "../indexer/blockSource";

async function main() {
  await saveJson("tokens", { ["ab".repeat(16)]: { name: "Doge", symbol: "DOGE", decimals: 6, image: "" } });
  await saveJson("comments", [{ id: "c1", tokenId: "ab".repeat(16), account: "nano_x", text: "gm", time: 1, signature: "s" }]);

  // 1. Export is deterministic and self-verifying.
  const a = await exportSnapshot();
  const b = await exportSnapshot();
  assert.equal(a.hash, b.hash, "same state → same hash");
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.ok(verifySnapshotJson(a.json, a.hash), "snapshot verifies against its hash");
  assert.ok(!verifySnapshotJson(a.json + " ", a.hash), "any mutation breaks verification");

  // 2. State change → new hash.
  await saveJson("comments", []);
  const c = await exportSnapshot();
  assert.notEqual(c.hash, a.hash, "state change moves the hash");

  // 3. Anchor detection: a send whose link is the hash counts; receives or
  //    other links don't.
  const mk = (link: string, subtype: string): NanoBlock => ({
    account: "nano_anchor",
    hash: "h",
    previous: "p",
    link,
    representative: "r",
    height: 1n,
    amount: "1",
    subtype,
  });
  assert.ok(isAnchored([mk(a.hash, "send")], a.hash), "send-to-hash anchors");
  assert.ok(isAnchored([mk(a.hash.toUpperCase(), "send")], a.hash), "case-insensitive");
  assert.ok(!isAnchored([mk(a.hash, "receive")], a.hash), "receive doesn't anchor");
  assert.ok(!isAnchored([mk("f".repeat(64), "send")], a.hash), "other links don't anchor");

  console.log("✅ epoch snapshot tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
