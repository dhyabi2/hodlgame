import { strict as assert } from "node:assert";
import { analyze, priceOf } from "./analytics";
import type { IndexedEvent } from "../indexer/multiIndexer";
import { tokenIdFromLaunchHash } from "../core/token";

const TA = tokenIdFromLaunchHash("a".repeat(64));
const CREATOR = "nano_creator";
const ALICE = "nano_alice";

function ev(tokenId: string, op: any, sender: string, height: bigint, time?: number): IndexedEvent {
  return { tokenId, op, sender, height, timestamp: time, hash: "h" + height };
}

// seedLiq=commit-reveal op is represented directly here (analytics only folds).
const events: IndexedEvent[] = [
  ev(TA, { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" }, CREATOR, 1n, 1000),
  ev(TA, { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, CREATOR, 2n, 1001),
  ev(TA, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, ALICE, 3n, 1002),
];

const { state, byToken } = analyze(events);

// 1. price = poolXno * 10^decimals / poolTokens.
{
  const a = byToken.get(TA)!;
  const s = state.get(TA)!;
  const expected = priceOf(s.poolXno, s.poolTokens, 6);
  assert.equal(a.priceRaw, expected.toString(), "price matches AMM");
  assert.ok(BigInt(a.priceRaw) > 0n, "positive price");
}

// 2. market cap = price * supply / 10^decimals.
{
  const a = byToken.get(TA)!;
  const s = state.get(TA)!;
  const expected = (BigInt(a.priceRaw) * s.supply) / 10n ** 6n;
  assert.equal(a.marketCapRaw, expected.toString(), "market cap matches");
}

// 3. holders sorted desc, includes creator + buyer.
{
  const a = byToken.get(TA)!;
  assert.ok(a.holders.length >= 2, "creator + buyer present");
  assert.ok(a.holders.some((h) => h.account === CREATOR), "creator listed");
  assert.ok(a.holders.some((h) => h.account === ALICE), "buyer listed");
  for (let i = 1; i < a.holders.length; i++) {
    assert.ok(BigInt(a.holders[i - 1].balanceRaw) >= BigInt(a.holders[i].balanceRaw), "holders sorted desc");
  }
}

// 4. trade feed has the buy, series has points only at liquidity events.
{
  const a = byToken.get(TA)!;
  assert.equal(a.trades.length, 1, "one trade");
  assert.equal(a.trades[0].kind, "buy");
  assert.ok(a.series.length >= 2, "series records after seedLiq and buy");
  for (let i = 1; i < a.series.length; i++) {
    assert.ok(a.series[i].time > a.series[i - 1].time, "series times are monotonic");
  }
}

console.log("✅ analytics tests passed");