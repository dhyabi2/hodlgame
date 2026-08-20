import { strict as assert } from "node:assert";
import { encodeOpLink, decodeOpLink } from "./oplink";
import { tokenIdFromLaunchHash } from "./token";
import type { Op } from "./ops";

const TOKEN = tokenIdFromLaunchHash("deadbeef".repeat(8));

const OPS: Op[] = [
  { kind: "launch", supply: 1_000_000_000_000n, name: "H", symbol: "H", decimals: 6, image: "" },
  { kind: "buy", xno: 10n ** 30n, minTokens: 0n },
  { kind: "sell", tokens: 5_000_000_000n, minXno: 0n },
  { kind: "stake", amount: 1_000_000n },
  { kind: "unstake", amount: 250_000n },
  { kind: "claim" },
];

// 1. Round-trip: encode + decode yields the same tokenId and primary amount.
for (const op of OPS) {
  const enc = encodeOpLink(TOKEN, op);
  assert.equal(enc.length, 64, `link must be 32 bytes (${op.kind})`);
  const { tokenId, op: dec } = decodeOpLink(enc, { name: "H", symbol: "H", decimals: 6, image: "" });
  if (op.kind === "launch") {
    assert.equal(dec.kind, "launch");
    assert.equal(dec.kind === "launch" ? dec.supply : 0n, op.supply, "launch supply round-trips");
  } else {
    assert.equal(tokenId, TOKEN, `tokenId round-trips (${op.kind})`);
  }
}

// 2. buy/sell carry their primary amount; slippage decodes to 0 (compact limit).
{
  const buy = decodeOpLink(encodeOpLink(TOKEN, { kind: "buy", xno: 12345n, minTokens: 0n }));
  assert.equal(buy.op.kind, "buy");
  assert.equal(buy.op.kind === "buy" ? buy.op.xno : 0n, 12345n);
  const sell = decodeOpLink(encodeOpLink(TOKEN, { kind: "sell", tokens: 999n, minXno: 0n }));
  assert.equal(sell.op.kind, "sell");
  assert.equal(sell.op.kind === "sell" ? sell.op.tokens : 0n, 999n);
}

// 3. launch carries a zero tokenId slot (the id is derived from its block hash).
{
  const { tokenId, op } = decodeOpLink(encodeOpLink(TOKEN, { kind: "launch", supply: 5n, name: "", symbol: "", decimals: 6, image: "" }));
  assert.equal(op.kind, "launch");
  assert.equal(tokenId, "0".repeat(32), "launch has no embedded tokenId");
}

// 4. tokenId slot must survive a full 128-bit value.
{
  const id = tokenIdFromLaunchHash("0123456789abcdef".repeat(4));
  const { tokenId } = decodeOpLink(encodeOpLink(id, { kind: "claim" }));
  assert.equal(tokenId, id, "full 128-bit tokenId round-trips");
}

console.log("✅ multi-token op-link codec tests passed");
