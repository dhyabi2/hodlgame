import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { encodeFragLinks, isFragA, assembleFrag, FRAG_HIGH } from "./fraglink";
import { encodeOpLink, decodeOpLink } from "./oplink";
import { OP_CODE } from "./ops";

const TOKEN = "ab".repeat(16);
const TO = nanocurrency.deriveAddress(nanocurrency.derivePublicKey(nanocurrency.deriveSecretKey("6".repeat(64), 0)), {
  useNanoPrefix: true,
});

// 1. transfer round-trip (recipient survives address→pubkey→address).
{
  const op = { kind: "transfer" as const, to: TO, amount: 123_456_789_012_345n };
  const [a, b] = encodeFragLinks(TOKEN, op);
  assert.equal(a.length, 64);
  assert.equal(b.length, 64);
  assert.ok(isFragA(a), "frag A carries the marker");
  assert.ok(!isFragA(b), "frag B carries no marker");
  const d = assembleFrag(a, b);
  assert.equal(d.tokenId, TOKEN.toLowerCase());
  assert.deepEqual(d.op, op, "transfer round-trips");
}

// 2. sell round-trip incl. max 15-byte amounts; padding enforced.
{
  const max = (1n << 120n) - 1n;
  const op = { kind: "sell" as const, tokens: max, minXno: 42n };
  const [a, b] = encodeFragLinks(TOKEN, op);
  assert.deepEqual(assembleFrag(a, b).op, op, "sell round-trips at 15-byte max");

  const tamperedB = b.slice(0, 62) + "ff"; // corrupt trailing padding
  assert.throws(() => assembleFrag(a, tamperedB), /padding/, "nonzero sell padding rejected");
}

// 3. Marker space is disjoint from compact opcodes and commit links.
{
  for (const kind of ["launch", "buy", "sell", "stake", "unstake", "claim", "seedLiq", "addLiq"] as const) {
    assert.ok((OP_CODE[kind] & 0xf0) !== FRAG_HIGH, `compact ${kind} never looks like frag A`);
  }
  assert.ok(!isFragA("ff" + "0".repeat(62)), "commit marker is not frag A");
  assert.ok(!isFragA((0xe1).toString(16) + "0".repeat(62)), "unfraggable opcode nibble rejected");
}

// 4. Compact seedLiq/addLiq round-trip (they left the commit path: tokens in
//    the amount slot, xno bound later by the chained deposit).
{
  const link = encodeOpLink(TOKEN, { kind: "seedLiq", xno: 0n, tokens: 950_000_000_000n });
  const d = decodeOpLink(link);
  assert.deepEqual(d.op, { kind: "seedLiq", xno: 0n, tokens: 950_000_000_000n });
  assert.equal(d.tokenId, TOKEN.toLowerCase());
  const add = decodeOpLink(encodeOpLink(TOKEN, { kind: "addLiq", xno: 7n, tokens: 5n }));
  assert.deepEqual(add.op, { kind: "addLiq", xno: 0n, tokens: 5n }, "declared xno is dead weight — deposit binds it");
}

// 5. Transfer to the all-zero pubkey rejected (burn-by-typo guard).
{
  const zeroA = ((FRAG_HIGH | OP_CODE.transfer).toString(16) + TOKEN + "0".repeat(30)).toLowerCase();
  assert.throws(() => assembleFrag(zeroA, "0".repeat(64)), /zero pubkey/, "zero recipient rejected");
}

console.log("✅ fragment link tests passed");
