import { strict as assert } from "node:assert";
import {
  emptyState,
  applyOp,
  applyOps,
  InvalidOp,
  MAX_CREATOR_SHARE_BPS,
  BPS,
  TAX_BPS,
  TAX_BURN_SHARE_BPS,
} from "./state";

const CREATOR = "nano_creator";
const ALICE = "nano_alice";
const BOB = "nano_bob";

function launch(supply: bigint) {
  return applyOp(
    emptyState(),
    { kind: "launch", supply, name: "Test", symbol: "TST", decimals: 6, image: "" },
    CREATOR,
    1n
  );
}

function expectThrow(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidOp) return;
    throw e;
  }
  assert.fail("expected InvalidOp");
}

// 1. Creator gets exactly 5%, treasury 95%, structural cap.
{
  const s = launch(1_000_000_000_000n); // 1M tokens * 10^6
  const expectedCreator = (1_000_000_000_000n * MAX_CREATOR_SHARE_BPS) / BPS;
  assert.equal(s.balances.get(CREATOR), expectedCreator, "creator = 5%");
  assert.equal(s.treasury, 1_000_000_000_000n - expectedCreator, "treasury = 95%");
  assert.equal(s.creatorShare, expectedCreator);
  // cap invariant holds by construction
  assert.ok(s.creatorShare * 100n <= s.supply * 5n, "creator <= 5%");
}

// 2. Tiny supply still yields a >0 creator share (rejects sub-20 units).
{
  expectThrow(() => launch(19n));
  assert.doesNotThrow(() => launch(20n));
}

// 3. Second launch rejected.
{
  const s = launch(1_000_000n);
  expectThrow(() =>
    applyOp(s, { kind: "launch", supply: 5n, name: "x", symbol: "X", decimals: 0, image: "" }, CREATOR, 2n)
  );
}

// 4. Supply is locked: nothing increases it after launch.
{
  let s = launch(1_000_000_000_000n);
  const supplyAfterLaunch = s.supply;
  const creatorBal = s.balances.get(CREATOR)!;
  s = applyOp(s, { kind: "transfer", to: ALICE, amount: creatorBal }, CREATOR, 2n);
  s = applyOp(s, { kind: "stake", amount: creatorBal }, ALICE, 3n);
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: s.treasury }, CREATOR, 4n);
  assert.equal(s.supply, supplyAfterLaunch, "supply unchanged by transfer/stake/seed");
}

// 5. Transfer double-spend rejected.
{
  const s = launch(1_000_000_000_000n);
  const s2 = applyOp(s, { kind: "transfer", to: BOB, amount: s.balances.get(CREATOR)! }, CREATOR, 2n);
  expectThrow(() => applyOp(s2, { kind: "transfer", to: BOB, amount: 1n }, CREATOR, 3n));
}

// 6. Constant-product invariant non-decreasing across a swap.
{
  let s = launch(1_000_000_000_000n);
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: s.treasury }, CREATOR, 2n);
  const k = s.poolXno * s.poolTokens;
  s = applyOp(s, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, ALICE, 3n);
  assert.ok(s.poolXno * s.poolTokens >= k, "invariant preserved (fee retained)");
  assert.ok((s.balances.get(ALICE) ?? 0n) > 0n, "buyer received tokens");
}

// 7. Unstake tax split: 80% user / 5% burn / 15% rebate.
{
  let s = launch(1_000_000_000_000n);
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: s.treasury }, CREATOR, 2n);
  s = applyOp(s, { kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, ALICE, 3n);
  const amount = s.balances.get(ALICE)!;
  const supplyBefore = s.supply;
  const rebateBefore = s.rebateVault;
  s = applyOp(s, { kind: "stake", amount }, ALICE, 4n);
  s = applyOp(s, { kind: "unstake", amount }, ALICE, 5n);

  const tax = (amount * TAX_BPS) / BPS;
  const burn = (tax * TAX_BURN_SHARE_BPS) / BPS;
  const rebate = tax - burn;
  const toUser = amount - tax;

  assert.equal(s.balances.get(ALICE), toUser, "user gets 80%");
  assert.equal(supplyBefore - s.supply, burn, "5% burned");
  assert.equal(s.rebateVault - rebateBefore, rebate, "15% to rebate vault");
}

// 8. Deterministic: two replays are identical.
{
  const blocks = [
    { op: { kind: "launch" as const, supply: 1_000_000_000_000n, name: "T", symbol: "T", decimals: 6, image: "" }, sender: CREATOR, height: 1n },
    { op: { kind: "seedLiq" as const, xno: 1_000_000_000n, tokens: 950_000_000_000n }, sender: CREATOR, height: 2n },
    { op: { kind: "buy" as const, xno: 100_000_000n, minTokens: 0n }, sender: ALICE, height: 3n },
    { op: { kind: "sell" as const, tokens: 10_000_000n, minXno: 0n }, sender: ALICE, height: 4n },
  ];
  const a = applyOps(emptyState(), blocks);
  const b = applyOps(emptyState(), blocks);
  assert.deepEqual(a, b, "replays are byte-identical");
}

// 9. Claim pays accrued rebates to a staker.
{
  let s = launch(1_000_000_000_000n);
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: s.treasury }, CREATOR, 2n);
  s = applyOp(s, { kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, ALICE, 3n);
  const amount = s.balances.get(ALICE)!;
  s = applyOp(s, { kind: "stake", amount }, ALICE, 4n);
  // A second user unstakes to fund the rebate vault.
  s = applyOp(s, { kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, BOB, 5n);
  const bobAmt = s.balances.get(BOB)!;
  s = applyOp(s, { kind: "stake", amount: bobAmt }, BOB, 6n);
  s = applyOp(s, { kind: "unstake", amount: bobAmt }, BOB, 7n); // funds rebateVault
  // Advance height so ALICE accrues points, then claim.
  const before = s.balances.get(ALICE) ?? 0n;
  s = applyOp(s, { kind: "claim" }, ALICE, 100n);
  assert.ok((s.balances.get(ALICE) ?? 0n) > before, "staker claimed > 0");
}

console.log("✅ All Nano L2 state-machine tests passed");
