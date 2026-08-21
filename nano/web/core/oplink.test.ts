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

// 2. buy carries its slippage guard (minTokens); xno is bound by the deposit.
{
  const buy = decodeOpLink(encodeOpLink(TOKEN, { kind: "buy", xno: 0n, minTokens: 900_000n }));
  assert.equal(buy.op.kind, "buy");
  assert.equal(buy.op.kind === "buy" ? buy.op.minTokens : 0n, 900_000n, "minTokens round-trips");
  assert.equal(buy.op.kind === "buy" ? buy.op.xno : 1n, 0n, "buy op carries no xno (value-bound)");
  const sell = decodeOpLink(encodeOpLink(TOKEN, { kind: "sell", tokens: 999n, minXno: 0n }));
  assert.equal(sell.op.kind, "sell");
  assert.equal(sell.op.kind === "sell" ? sell.op.tokens : 0n, 999n);
}

// 3. launch: tokenId is derived from the block hash, and DECIMALS are bound
//    on-chain in byte 1 (decimals+1; immutable, exchange-pinnable).
{
  const link6 = encodeOpLink(TOKEN, { kind: "launch", supply: 5n, name: "", symbol: "", decimals: 6, image: "" });
  assert.equal(link6.slice(2, 4), "07", "decimals 6 encoded as byte 0x07");
  const { op } = decodeOpLink(link6);
  assert.equal(op.kind, "launch");
  assert.equal((op as any).decimals, 6, "decimals round-trips from the link, not meta");

  const link0 = decodeOpLink(encodeOpLink(TOKEN, { kind: "launch", supply: 5n, name: "", symbol: "", decimals: 0, image: "" }));
  assert.equal((link0.op as any).decimals, 0, "a real 0-decimals token is distinct from legacy");

  // Legacy link (byte 1 == 0, pre-decimals-binding) falls back to meta/6.
  const legacy = "01" + "00".repeat(31);
  assert.equal((decodeOpLink(legacy).op as any).decimals, 6, "legacy launch → 6");
  assert.equal((decodeOpLink(legacy, { name: "", symbol: "", decimals: 9, image: "" }).op as any).decimals, 9, "legacy honors meta decimals");
}

// 4. tokenId slot must survive a full 128-bit value.
{
  const id = tokenIdFromLaunchHash("0123456789abcdef".repeat(4));
  const { tokenId } = decodeOpLink(encodeOpLink(id, { kind: "claim" }));
  assert.equal(tokenId, id, "full 128-bit tokenId round-trips");
}


// oversized amount must throw, not silently wrap (supply-overflow guard)
{
  const TOO_BIG = 1n << 120n; // one past the 15-byte field max
  let threw = false;
  try { encodeOpLink("", { kind: "launch", supply: TOO_BIG, name: "X", symbol: "X", decimals: 6, image: "" }); }
  catch { threw = true; }
  assert.ok(threw, "encoding a supply > 2^120-1 throws instead of wrapping");
  // one below the max encodes + round-trips exactly
  const MAXOK = (1n << 120n) - 1n;
  const link = encodeOpLink("", { kind: "launch", supply: MAXOK, name: "X", symbol: "X", decimals: 6, image: "" });
  const dec: any = decodeOpLink(link);
  assert.equal(dec.op.supply, MAXOK, "max in-range supply round-trips exactly");
}

console.log("✅ multi-token op-link codec tests passed");
