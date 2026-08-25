import { strict as assert } from "node:assert";
import { emptyState, applyOp, BPS, TAX_BPS, TAX_BURN_SHARE_BPS, FULL_REBATE_ERA } from "./state";
import { applyBlock, multiEmpty } from "./multi";

const CREATOR = "nano_creator";
const ALICE = "nano_alice";
const BOB = "nano_bob";

function seeded() {
  let s = applyOp(emptyState(), { kind: "launch", supply: 1_000_000_000_000n, name: "T", symbol: "T", decimals: 6, image: "" }, CREATOR, 1n);
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: s.treasury }, CREATOR, 2n);
  s = applyOp(s, { kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, ALICE, 3n);
  s = applyOp(s, { kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, BOB, 4n);
  return s;
}

// 1. Legacy era (before FULL_REBATE_ERA, or no timestamp at all): the exact
//    historical split — 5% burned, 15% to the vault — so replayed history and
//    anchored roots never move.
for (const ts of [undefined, FULL_REBATE_ERA - 1]) {
  let s = seeded();
  const amount = s.balances.get(ALICE)!;
  s = applyOp(s, { kind: "stake", amount }, ALICE, 5n, ts);
  s = applyOp(s, { kind: "stake", amount: s.balances.get(BOB)! }, BOB, 6n, ts);
  const supplyBefore = s.supply, vaultBefore = s.rebateVault;
  s = applyOp(s, { kind: "unstake", amount }, ALICE, 7n, ts);
  const tax = (amount * TAX_BPS) / BPS;
  const burn = (tax * TAX_BURN_SHARE_BPS) / BPS;
  assert.equal(supplyBefore - s.supply, burn, `legacy (${ts}): 5% burned`);
  assert.equal(s.rebateVault - vaultBefore, tax - burn, `legacy (${ts}): 15% to vault`);
  assert.equal(s.balances.get(ALICE), amount - tax, `legacy (${ts}): user keeps 80%`);
}

// 2. Full-rebate era with a staker remaining: nothing burned, the WHOLE 20%
//    goes to the vault, and the remaining staker can claim all of it.
{
  let s = seeded();
  const amount = s.balances.get(ALICE)!;
  const bobAmt = s.balances.get(BOB)!;
  s = applyOp(s, { kind: "stake", amount }, ALICE, 5n, FULL_REBATE_ERA);
  s = applyOp(s, { kind: "stake", amount: bobAmt }, BOB, 6n, FULL_REBATE_ERA);
  const supplyBefore = s.supply, vaultBefore = s.rebateVault;
  s = applyOp(s, { kind: "unstake", amount }, ALICE, 7n, FULL_REBATE_ERA);
  const tax = (amount * TAX_BPS) / BPS;
  assert.equal(s.supply, supplyBefore, "new era: nothing burned");
  assert.equal(s.rebateVault - vaultBefore, tax, "new era: full 20% to vault");
  const bobBefore = s.balances.get(BOB) ?? 0n;
  s = applyOp(s, { kind: "claim" }, BOB, 8n, FULL_REBATE_ERA);
  const got = (s.balances.get(BOB) ?? 0n) - bobBefore;
  assert.ok(got > 0n && tax - got < 1000n, `sole remaining staker claims ~all of it (got ${got} of ${tax})`);
}

// 3. Full-rebate era, LAST staker leaves: the tax is burned, never stranded
//    in a vault nobody can claim from.
{
  let s = seeded();
  const amount = s.balances.get(ALICE)!;
  s = applyOp(s, { kind: "stake", amount }, ALICE, 5n, FULL_REBATE_ERA);
  const supplyBefore = s.supply, vaultBefore = s.rebateVault;
  s = applyOp(s, { kind: "unstake", amount }, ALICE, 6n, FULL_REBATE_ERA);
  const tax = (amount * TAX_BPS) / BPS;
  assert.equal(supplyBefore - s.supply, tax, "last staker: whole tax burned");
  assert.equal(s.rebateVault, vaultBefore, "last staker: vault untouched");
  assert.equal(s.totalStaked, 0n);
}

// 4. The timestamp reaches the state machine through the multi-token router
//    (the path every replayer uses), and an absent timestamp means legacy.
{
  let m = multiEmpty();
  const T = "t".repeat(32);
  const push = (op: any, sender: string, height: bigint, timestamp?: number) =>
    (m = applyBlock(m, { tokenId: T, op, sender, height, timestamp }));
  push({ kind: "launch", supply: 1_000_000_000_000n, name: "T", symbol: "T", decimals: 6, image: "" }, CREATOR, 1n);
  push({ kind: "seedLiq", xno: 1_000_000_000n, tokens: m.get(T)!.treasury }, CREATOR, 2n);
  push({ kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, ALICE, 3n);
  push({ kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, BOB, 4n);
  const amount = m.get(T)!.balances.get(ALICE)!;
  push({ kind: "stake", amount }, ALICE, 5n);
  push({ kind: "stake", amount: m.get(T)!.balances.get(BOB)! }, BOB, 6n);
  const before = m.get(T)!.supply;
  push({ kind: "unstake", amount }, ALICE, 7n, FULL_REBATE_ERA + 10);
  assert.equal(m.get(T)!.supply, before, "router passes timestamp → new-era rule (no burn)");
}

console.log("✅ unstake-tax era (full rebate, no burn) tests passed");
