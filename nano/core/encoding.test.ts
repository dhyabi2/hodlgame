import { strict as assert } from "node:assert";
import { encodeOp, decodeOp, opCommitment } from "./encoding";
import type { Op } from "./ops";

const OPS: Op[] = [
  { kind: "launch", supply: 1_000_000_000_000n, name: "HoldFun", symbol: "HOLD", decimals: 6, image: "ipfs://QmX" },
  { kind: "transfer", to: "nano_1abc", amount: 12345n },
  { kind: "buy", xno: 10n ** 30n, minTokens: 0n },
  { kind: "sell", tokens: 5_000_000_000n, minXno: 999n },
  { kind: "stake", amount: 1_000_000n },
  { kind: "unstake", amount: 250_000n },
  { kind: "claim" },
  { kind: "seedLiq", xno: 10n ** 30n, tokens: 950_000_000_000n },
  { kind: "addLiq", xno: 5n * 10n ** 29n, tokens: 100_000_000_000n },
];

for (const op of OPS) {
  const enc = encodeOp(op);
  const dec = decodeOp(enc);
  assert.deepEqual(dec, op, `round-trip failed for ${op.kind}`);
}

// Commitment is a stable 32-byte hex (blake2b-256), and distinct across ops.
{
  const c1 = opCommitment(OPS[0]);
  const c2 = opCommitment(OPS[1]);
  assert.match(c1, /^[0-9a-f]{64}$/, "commitment is 64 hex chars");
  assert.notEqual(c1, c2, "distinct ops -> distinct commitments");
  assert.equal(c1, opCommitment(OPS[0]), "deterministic commitment");
}

console.log("✅ encoding round-trip + commitment tests passed");
