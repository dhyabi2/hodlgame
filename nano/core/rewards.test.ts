import { strict as assert } from "node:assert";
import { emptyState, applyOp, InvalidOp, type State } from "./state";

const CREATOR = "nano_creator";
const ALICE = "nano_alice";
const BOB = "nano_bob";
const CAROL = "nano_carol";
const ATTACKER = "nano_attacker";

function launch(): State {
  return applyOp(
    emptyState(),
    { kind: "launch", supply: 1_000_000_000_000n, name: "T", symbol: "T", decimals: 6, image: "" },
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

// Rewards are distributed pro-rata by CURRENT stake, are bounded by the vault,
// cannot be inflated by a (per-account, attacker-controlled) block height, and
// cannot be claimed twice.
{
  let s = launch();
  // Fund three stakers directly from the creator's balance (5% = 5e10).
  s = applyOp(s, { kind: "transfer", to: ALICE, amount: 1_000_000n }, CREATOR, 2n);
  s = applyOp(s, { kind: "transfer", to: BOB, amount: 1_000_000_000n }, CREATOR, 3n); // 1000× ALICE
  s = applyOp(s, { kind: "transfer", to: CAROL, amount: 1_000_000_000n }, CREATOR, 4n);

  s = applyOp(s, { kind: "stake", amount: 1_000_000n }, ALICE, 5n);
  s = applyOp(s, { kind: "stake", amount: 1_000_000_000n }, BOB, 6n);

  // CAROL stakes then unstakes → funds the rebate vault; the rebate is shared by
  // the REMAINING stakers (ALICE + BOB), never by CAROL herself.
  s = applyOp(s, { kind: "stake", amount: 1_000_000_000n }, CAROL, 7n);
  s = applyOp(s, { kind: "unstake", amount: 1_000_000_000n }, CAROL, 8n);
  const vault = s.rebateVault;
  assert.ok(vault > 0n, "rebate vault funded");

  // ATTACKER never staked before the rebate → nothing to claim.
  expectThrow(() => applyOp(s, { kind: "claim" }, ATTACKER, 1_000_000_000n));

  // ALICE claims at an ABSURD block height; BOB claims at a normal height. If
  // height affected rewards, ALICE (tiny stake, huge height) could steal BOB's
  // share. It must not.
  const sAlice = applyOp(s, { kind: "claim" }, ALICE, 9_999_999_999n);
  const aliceGot = (sAlice.balances.get(ALICE) ?? 0n) - 0n;
  const sBoth = applyOp(sAlice, { kind: "claim" }, BOB, 9n);
  const bobGot = sBoth.balances.get(BOB) ?? 0n;

  assert.ok(aliceGot > 0n && bobGot > 0n, "both stakers earned a share");
  // BOB staked 1000× ALICE → BOB earns ~1000× ALICE, regardless of ALICE's height.
  assert.ok(bobGot > aliceGot * 900n, "reward is stake-proportional, not height-inflatable");
  // Conservation: total paid can never exceed the vault that was funded.
  assert.ok(aliceGot + bobGot <= vault, "total claimed <= vault (bounded)");
  assert.ok(sBoth.rebateVault >= 0n, "vault never negative");

  // Second claim with no new rebate pays nothing (no repeat-drain).
  expectThrow(() => applyOp(sBoth, { kind: "claim" }, ALICE, 20_000_000_000n));
  expectThrow(() => applyOp(sBoth, { kind: "claim" }, BOB, 20_000_000_000n));
}

// A tiny-stake attacker can never capture more than their pro-rata slice.
{
  let s = launch();
  s = applyOp(s, { kind: "transfer", to: ATTACKER, amount: 1n }, CREATOR, 2n);
  s = applyOp(s, { kind: "transfer", to: BOB, amount: 1_000_000_000n }, CREATOR, 3n);
  s = applyOp(s, { kind: "transfer", to: CAROL, amount: 1_000_000_000n }, CREATOR, 4n);
  s = applyOp(s, { kind: "stake", amount: 1n }, ATTACKER, 5n);
  s = applyOp(s, { kind: "stake", amount: 1_000_000_000n }, BOB, 6n);
  s = applyOp(s, { kind: "stake", amount: 1_000_000_000n }, CAROL, 7n);
  s = applyOp(s, { kind: "unstake", amount: 1_000_000_000n }, CAROL, 8n);
  const vault = s.rebateVault;
  // Attacker claims from an absurdly inflated height. Their slice is ~stake/total
  // (≈ 1 / 1e9 of the rebate), which floors to nothing — never the vault.
  let after = s;
  try {
    after = applyOp(s, { kind: "claim" }, ATTACKER, 10n ** 18n);
  } catch {
    /* "nothing to claim" — the slice floored to 0; that's the strongest outcome */
  }
  const got = vault - after.rebateVault;
  assert.ok(got * 1_000n < vault, "tiny stake cannot drain the vault");
}

console.log("✅ reward fairness / anti-drain tests passed");
