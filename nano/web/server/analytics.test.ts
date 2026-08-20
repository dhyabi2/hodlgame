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

// 5. sell payouts are computed at each sell's execution point (path-dependent).
{
  const flow: IndexedEvent[] = [
    ev(TA, { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" }, CREATOR, 1n),
    ev(TA, { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, CREATOR, 2n),
    ev(TA, { kind: "sell", tokens: 10_000_000_000n, minXno: 0n }, CREATOR, 3n),
    ev(TA, { kind: "sell", tokens: 10_000_000_000n, minXno: 0n }, ALICE, 4n),
  ];
  // ALICE needs tokens: buy after the sells, or give her balance via transfer.
  // Simpler: both sells from CREATOR.
  flow[3] = ev(TA, { kind: "sell", tokens: 10_000_000_000n, minXno: 0n }, CREATOR, 4n);

  const { sellPayouts } = analyze(flow);
  assert.equal(sellPayouts.length, 2, "two sells recorded");

  let xno = 1_000_000_000n;
  let tokens = 950_000_000_000n;
  const expected = sellPayouts.map((p) => {
    const out = (10_000_000_000n * xno) / (tokens + 10_000_000_000n);
    xno -= out;
    tokens += 10_000_000_000n;
    return out;
  });

  assert.equal(sellPayouts[0].amountRaw, expected[0], "first sell against seed reserves");
  assert.equal(sellPayouts[1].amountRaw, expected[1], "second sell against post-first reserves");
  assert.ok(sellPayouts[1].amountRaw < sellPayouts[0].amountRaw, "sequential sells pay decreasing XNO (slippage)");
  assert.equal(sellPayouts[0].to, CREATOR, "payout goes to seller");
}

console.log("✅ analytics tests passed");