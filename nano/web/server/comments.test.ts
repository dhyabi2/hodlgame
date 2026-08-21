import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nanocurrency from "nanocurrency";
import { commentSignDigest } from "../core/commentAuth";

// Isolate the store before importing modules that use it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "holdfun-comments-"));

import { addComment, commentsFor } from "./comments";

const SEED = "3".repeat(64);
const secretKey = nanocurrency.deriveSecretKey(SEED, 0);
const publicKey = nanocurrency.derivePublicKey(secretKey);
const AUTHOR = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
const OTHER = nanocurrency.deriveAddress(nanocurrency.derivePublicKey(nanocurrency.deriveSecretKey("4".repeat(64), 0)), { useNanoPrefix: true });
const TOKEN = "cd".repeat(16);

function sign(tokenId: string, time: number, text: string): string {
  return nanocurrency.signBlock({ hash: commentSignDigest(tokenId, time, text), secretKey });
}

async function main() {
  const time = Date.now();

  // 1. Valid signed comment is stored.
  const r1 = await addComment(TOKEN, AUTHOR, "gm", time, sign(TOKEN, time, "gm"));
  assert.ok(r1.ok, "valid signed comment accepted");
  assert.equal((await commentsFor(TOKEN)).length, 1);

  // 2. Tampered text / wrong author / wrong token all rejected.
  assert.ok(!(await addComment(TOKEN, AUTHOR, "evil", time, sign(TOKEN, time, "gm"))).ok, "tampered text rejected");
  assert.ok(!(await addComment(TOKEN, OTHER, "gm", time, sign(TOKEN, time, "gm"))).ok, "spoofed author rejected");
  assert.ok(!(await addComment("ef".repeat(16), AUTHOR, "gm", time, sign(TOKEN, time, "gm"))).ok, "wrong token rejected");

  // 3. Replay is idempotent: same signature → same id, no duplicate row.
  const r2 = await addComment(TOKEN, AUTHOR, "gm", time, sign(TOKEN, time, "gm"));
  assert.ok(r2.ok && r2.comment.id === (r1 as any).comment.id, "replay returns same comment");
  assert.equal((await commentsFor(TOKEN)).length, 1, "no duplicate stored");

  // 4. Stale timestamp rejected (signature valid but outside skew window).
  const old = time - 11 * 60 * 1000;
  assert.ok(!(await addComment(TOKEN, AUTHOR, "late", old, sign(TOKEN, old, "late"))).ok, "stale time rejected");

  // 5. Over-long text rejected (never silently truncated — signature covers exact text).
  const long = "x".repeat(281);
  assert.ok(!(await addComment(TOKEN, AUTHOR, long, time, sign(TOKEN, time, long))).ok, "over-long text rejected");

  console.log("✅ signed comment tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
