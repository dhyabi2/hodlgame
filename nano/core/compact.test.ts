import { strict as assert } from "node:assert";
import { encodeOpCompact, decodeOpCompact } from "./compact";
import type { Op } from "./ops";

const OPS: { op: Op; meta?: any }[] = [
  { op: { kind: "launch", supply: 1_000_000_000_000n, name: "H", symbol: "H", decimals: 6, image: "" } },
  { op: { kind: "buy", xno: 10n ** 30n, minTokens: 12345n } },
  { op: { kind: "sell", tokens: 5_000_000_000n, minXno: 999n } },
  { op: { kind: "stake", amount: 1_000_000n } },
  { op: { kind: "unstake", amount: 250_000n } },
  { op: { kind: "claim" } },
  { op: { kind: "seedLiq", xno: 10n ** 30n, tokens: 950_000_000_000n } },
  { op: { kind: "addLiq", xno: 5n * 10n ** 29n, tokens: 100_000_000_000n } },
];

for (const { op } of OPS) {
  const enc = encodeOpCompact(op);
  assert.equal(enc.length, 64, `compact link must be 32 bytes (${op.kind})`);
  const dec = decodeOpCompact(enc, {
    name: op.kind === "launch" ? "H" : "",
    symbol: op.kind === "launch" ? "H" : "",
    decimals: 6,
    image: "",
  });
  assert.deepEqual(dec, op, `round-trip failed for ${op.kind}`);
}

console.log("✅ compact encoding round-trip tests passed");
