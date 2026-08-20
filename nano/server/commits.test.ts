import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerCommit, loadCommits, commitResolver } from "./commits";
import { commitLink, verifyCommit } from "../core/commit";
import { tokenIdFromLaunchHash } from "../core/token";

const TOKEN = tokenIdFromLaunchHash("a".repeat(64));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commits-"));
process.env.DATA_DIR = tmp;

// 1. register returns a valid commit link and persists a resolvable entry.
{
  const op = { kind: "buy" as const, xno: 10n ** 28n, minTokens: 900_000n };
  const link = registerCommit(TOKEN, op);
  assert.equal(link, commitLink(TOKEN, op), "link matches commit");
  assert.ok(verifyCommit(TOKEN, op, link), "verify passes");

  const map = loadCommits();
  assert.ok(map.has(link.toLowerCase()), "persisted to registry");
}

// 2. resolver returns the op (bigints revived) and rejects wrong links.
{
  const op = { kind: "sell" as const, tokens: 1_000_000n, minXno: 5n * 10n ** 26n };
  registerCommit(TOKEN, op);
  const resolve = commitResolver();
  const hit = resolve(commitLink(TOKEN, op));
  assert.ok(hit, "resolved");
  assert.equal(hit!.op.kind, "sell");
  assert.equal(hit!.op.tokens, 1_000_000n, "bigint revived");
  assert.equal(hit!.op.minXno, 5n * 10n ** 26n, "minXno revived");

  assert.equal(resolve("ff".padEnd(64, "0")), null, "unknown link → null");
}

console.log("✅ commit-reveal registry tests passed");