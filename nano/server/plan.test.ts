import { strict as assert } from "node:assert";
import { applyBlock, multiEmpty } from "../core/multi";
import { tokenIdFromLaunchHash } from "../core/token";
import { planSellPayouts } from "./plan";
import type { SellRecord } from "../indexer/multiIndexer";

const TA = tokenIdFromLaunchHash("a".repeat(64));
const TB = tokenIdFromLaunchHash("b".repeat(64));
const CREATOR = "nano_creator";
const ALICE = "nano_alice";

function sell(tokenId: string, tokens: bigint, minXno: bigint, hash: string): SellRecord {
  return { tokenId, sender: ALICE, tokens, minXno, hash };
}

let state = multiEmpty();
state = applyBlock(state, { tokenId: TA, op: { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" }, sender: CREATOR, height: 1n });
state = applyBlock(state, { tokenId: TA, op: { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, sender: CREATOR, height: 2n });
state = applyBlock(state, { tokenId: TB, op: { kind: "launch", supply: 2_000_000_000_000n, name: "B", symbol: "B", decimals: 6, image: "" }, sender: CREATOR, height: 3n });
state = applyBlock(state, { tokenId: TB, op: { kind: "seedLiq", xno: 2_000_000_000n, tokens: 1_900_000_000_000n }, sender: CREATOR, height: 4n });

// 1. Valid sell on token A → one payout matching the AMM formula.
{
  const tokens = 100_000_000n;
  const { payouts, skipped } = planSellPayouts(state, [sell(TA, tokens, 0n, "h1")]);
  assert.equal(skipped.length, 0, "no skips");
  assert.equal(payouts.length, 1, "one payout");
  const a = state.get(TA)!;
  const expected = (tokens * a.poolXno) / (a.poolTokens + tokens);
  assert.equal(payouts[0].tokenId, TA);
  assert.equal(payouts[0].to, ALICE);
  assert.equal(payouts[0].amountRaw, expected, "XNO out matches AMM");
  assert.ok(payouts[0].amountRaw > 0n && payouts[0].amountRaw < a.poolXno, "out is inside the pool reserve");
}

// 2. Slippage rejects an over-minXno sell; unknown token skips as no-liquidity.
{
  const { payouts, skipped } = planSellPayouts(state, [
    sell(TA, 100_000_000n, 10n ** 30n, "h2"), // minXno absurdly high
    sell("nonexistent", 1n, 0n, "h3"),
  ]);
  assert.equal(payouts.length, 0, "no payouts");
  const reasons = skipped.map((s) => s.reason).sort();
  assert.ok(reasons.includes("slippage"), "slippage flagged");
  assert.ok(reasons.includes("no liquidity"), "unknown token flagged");
}

// 3. Isolation: token B's pool is untouched by a token A sell plan.
{
  const bBefore = state.get(TB)!;
  const { payouts } = planSellPayouts(state, [sell(TA, 50_000_000n, 0n, "h4")]);
  assert.equal(payouts.length, 1);
  assert.equal(state.get(TB)!.poolXno, bBefore.poolXno, "B pool unaffected (planning is pure)");
}

console.log("✅ sell-payout planning tests passed");