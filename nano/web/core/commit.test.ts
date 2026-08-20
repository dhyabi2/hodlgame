import { strict as assert } from "node:assert";
import { commitLink, isCommitLink, verifyCommit } from "./commit";
import { tokenIdFromLaunchHash } from "./token";
import type { Op } from "./ops";

const TOKEN = tokenIdFromLaunchHash("deadbeef".repeat(8));

const OPS: Op[] = [
  { kind: "transfer", to: "nano_alice", amount: 1_000_000n },
  { kind: "seedLiq", xno: 10n ** 30n, tokens: 950_000_000_000n },
  { kind: "addLiq", xno: 5n * 10n ** 29n, tokens: 100_000_000_000n },
];

// 1. Commit link is 32 bytes, marked with 0xFF, and verifies.
for (const op of OPS) {
  const link = commitLink(TOKEN, op);
  assert.equal(link.length, 64, "commit link is 32 bytes");
  assert.ok(isCommitLink(link), "commit link is marked 0xFF");
  assert.ok(verifyCommit(TOKEN, op, link), "verify passes for correct tokenId+op");
}

// 2. Wrong tokenId or op fails verification.
{
  const link = commitLink(TOKEN, OPS[1]);
  const other = tokenIdFromLaunchHash("beefdead".repeat(8));
  assert.ok(!verifyCommit(other, OPS[1], link), "wrong tokenId rejected");
  assert.ok(!verifyCommit(TOKEN, { kind: "seedLiq", xno: 1n, tokens: 1n }, link), "wrong op rejected");
}

// 3. Compact links are not commit links; distinct ops hash distinctly.
{
  assert.ok(!isCommitLink("03".repeat(32)), "compact opcode 0x03 is not a commit");
  const a = commitLink(TOKEN, OPS[1]);
  const b = commitLink(TOKEN, OPS[2]);
  assert.notEqual(a, b, "distinct ops produce distinct commits");
}

console.log("✅ commit-reveal link tests passed");