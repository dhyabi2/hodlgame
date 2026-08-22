// Direct-Settlement (zero-custody) consensus tests.
//
// These encode the ADVERSARIALLY-VERIFIED economics as executable invariants:
//  * a round-trip seller can never extract more than their own deposit without
//    other participants' money (queue stays empty);
//  * the flow-backed queue equals EXACTLY the unpaid exit-realized
//    appreciation (actual-balance netting kills ratchet leakage);
//  * a creator with no earmark dumping into virtual liquidity gets nothing;
//  * collateral defection is detected from signed balances and voided
//    proportionally — including across tokens (no double-committed XNO);
//  * queue-first routing: no new self-earmark exposure while sellers wait.

import { strict as assert } from "node:assert";
import { applyOp, emptyState, type State } from "./state";
import { applyBlock, multiEmpty, type MultiState } from "./multi";
import { stateRoot } from "./canonical";

const CR = "nano_creator";
const A = "nano_alice";
const B = "nano_bob";
const C = "nano_carol";
const D = "nano_dave";

const SUPPLY = 1_000_000_000_000n;
const SEED_X = 100_000_000n; // virtual XNO reserve
const SEED_T = 1_000_000_000n; // tokens from treasury

let h = 0n;
const next = () => ++h;

function freshDirect(): State {
  let s = emptyState();
  s = applyOp(s, { kind: "launch", supply: SUPPLY, name: "D", symbol: "D", decimals: 6, image: "", direct: true }, CR, next());
  s = applyOp(s, { kind: "seedLiq", xno: SEED_X, tokens: SEED_T }, CR, next());
  return s;
}

const buyEarmark = (s: State, who: string, xno: bigint, balanceAt: bigint) =>
  applyOp(s, { kind: "buy", xno, minTokens: 0n, balanceAt }, who, next());
const buyRouted = (s: State, who: string, xno: bigint, payee: string) =>
  applyOp(s, { kind: "buy", xno, minTokens: 0n, depositTo: payee }, who, next());
const sell = (s: State, who: string, tokens: bigint, balanceAt: bigint, minXno = 0n) =>
  applyOp(s, { kind: "sell", tokens, minXno, balanceAt }, who, next());
const queueTotal = (s: State) => s.queue.reduce((t, e) => t + e.owed, 0n);

// ── 1. launch/seed basics ────────────────────────────────────────────────────
{
  const s = freshDirect();
  assert.equal(s.direct, true);
  assert.equal(s.poolXno, SEED_X);
  assert.equal(s.poolTokens, SEED_T);
  assert.equal(s.balances.get(CR), SUPPLY / 20n); // 5% creator share
  // withdraw is a pooled-era op — meaningless (and invalid) on direct tokens
  assert.throws(() => applyOp(s, { kind: "withdraw" }, A, next()), /settle at sell/);
  console.log("1 ok: direct launch + virtual seed");
}

// ── 2. round-trip: seller profit without others is impossible (queue empty) ──
{
  let s = freshDirect();
  s = buyEarmark(s, A, 100_000_000n, 200_000_000n);
  const aTok = s.balances.get(A)!;
  assert.equal(aTok, (99_000_000n * SEED_T) / (SEED_X + 99_000_000n)); // 1% fee curve
  assert.equal(s.earmark.get(A), 100_000_000n);
  const floorA = s.earmarkFloor.get(A)!;
  const sv = (aTok * s.poolXno) / (s.poolTokens + aTok);
  assert.equal(floorA, sv); // floor ratcheted to instant sell-value
  assert(floorA < 100_000_000n && floorA > 98_000_000n);

  const out = (aTok * s.poolXno) / (s.poolTokens + aTok);
  s = sell(s, A, aTok, 200_000_000n);
  // out < earmark → fully self-netted from A's OWN collateral; nothing queued
  assert.equal(s.queue.length, 0);
  assert.equal(s.earmark.get(A), 100_000_000n - out);
  assert.equal(s.balances.get(A) ?? 0n, 0n);
  console.log("2 ok: round-trip self-nets fully, queue stays empty");
}

// ── 3. appreciation queues EXACTLY (identity), buys pay the seller directly ──
{
  let s = freshDirect();
  s = buyEarmark(s, A, 100_000_000n, 200_000_000n);
  const aTok = s.balances.get(A)!;
  s = buyEarmark(s, C, 200_000_000n, 500_000_000n);
  const floorC = s.earmarkFloor.get(C)!;

  const out = (aTok * s.poolXno) / (s.poolTokens + aTok);
  assert(out > 100_000_000n, "A must have appreciated");
  const rem = out - 100_000_000n; // exit-realized appreciation, pre-haircut
  const den = rem; // empty queue before this sell
  const expectedCredit = floorC >= den ? rem : (rem * floorC) / den;

  const poolXnoBefore = s.poolXno;
  s = sell(s, A, aTok, 200_000_000n);
  // identity: instant settlement exactly the cost basis, queue exactly the
  // (haircut) appreciation — never a raw more, never released-collateral phantoms
  assert.equal(s.earmark.get(A) ?? 0n, 0n);
  assert.equal(s.queue.length, 1);
  assert.equal(s.queue[0].account, A);
  assert.equal(s.queue[0].owed, expectedCredit);
  // pool conservation: -out, +shaved
  assert.equal(s.poolXno, poolXnoBefore - out + (rem - expectedCredit));

  // queue-first: no new self-earmark exposure while a seller waits
  assert.throws(() => buyEarmark(s, D, 50_000_000n, 100_000_000n), /paid first/);
  // deposit to a non-queued account is not a buy
  assert.throws(() => buyRouted(s, D, 50_000_000n, B), /queued seller/);

  // D pays A directly, overpaying by 10M → mint on the residual only (C1),
  // excess becomes A's prepayment
  const owed = s.queue[0].owed;
  const poolTokensBefore = s.poolTokens;
  s = buyRouted(s, D, owed + 10_000_000n, A);
  assert.equal(s.queue.length, 0);
  assert.equal(s.prepaid.get(A), 10_000_000n);
  const minted = s.balances.get(D)!;
  const expectMint = (((owed * 9_900n) / 10_000n) * poolTokensBefore) / ((s.poolXno - owed) + (owed * 9_900n) / 10_000n);
  assert.equal(minted, expectMint);

  // A's next sell nets the prepayment FIRST (no double-pay)
  s = applyOp(s, { kind: "transfer", to: A, amount: minted / 2n }, D, next());
  const back = s.balances.get(A)!;
  const q0 = queueTotal(s);
  const preOut = (back * s.poolXno) / (s.poolTokens + back);
  s = sell(s, A, back, 0n); // zero balance: defector-grade netting, prepaid still nets
  const used = preOut < 10_000_000n ? preOut : 10_000_000n;
  assert.equal(s.prepaid.get(A) ?? 0n, 10_000_000n - used);
  assert(queueTotal(s) >= q0); // only the un-prepaid remainder may queue
  console.log("3 ok: queue == unpaid appreciation; routed buys settle it; prepay nets");
}

// ── 4. drawdown: NO ratchet leakage for honest holders; floor-netting for defectors ──
{
  // A and B both buy; A exits with the gain; B exits after the drawdown.
  let s = freshDirect();
  s = buyEarmark(s, A, 100_000_000n, 200_000_000n);
  const aTok = s.balances.get(A)!;
  s = buyEarmark(s, B, 100_000_000n, 150_000_000n);
  s = sell(s, A, aTok, 200_000_000n); // realizes appreciation, queues the rest
  const qAfterA = queueTotal(s);
  assert(qAfterA > 0n);

  const bTok = s.balances.get(B)!;
  const floorB = s.earmarkFloor.get(B)!;
  const outB = (bTok * s.poolXno) / (s.poolTokens + bTok);
  assert(outB < 100_000_000n, "B is under water");
  assert(floorB < 100_000_000n, "B's floor ratcheted below cost");

  // honest B (kept the full 100M in the wallet): nets ENTIRELY against own
  // collateral — adds NOTHING to the queue (the leakage counterexample, fixed)
  const honest = sell(s, B, bTok, 150_000_000n);
  assert.equal(queueTotal(honest), qAfterA);
  assert.equal(honest.earmark.get(B), 100_000_000n - outB);

  // defector B (stripped down to the floor): nets only what the chain proves,
  // the rest queues at a haircut — strictly worse for B, never for others
  const defector = sell(s, B, bTok, floorB);
  const netted = outB < floorB ? outB : floorB;
  assert.equal(queueTotal(defector) >= qAfterA, true);
  const bEntry = defector.queue.filter((e) => e.account === B).reduce((t, e) => t + e.owed, 0n);
  const remB = outB - netted;
  assert(bEntry <= remB); // haircut applied
  console.log("4 ok: actual-balance netting kills ratchet leakage; defectors self-punish");
}

// ── 4b. coverage headroom: queueTotal never exceeds floorTotal (no phantom claims) ──
{
  // Two earmarked buyers appreciate; A exits (queues), routed buys drain A's
  // queue while adding NO collateral, then B exits into the now-non-empty
  // queue. The credited claim must clamp to remaining coverage, never stack.
  let s = freshDirect();
  s = buyEarmark(s, A, 40_000_000n, 100_000_000n);
  const aTok = s.balances.get(A)!;
  s = buyEarmark(s, B, 40_000_000n, 100_000_000n);
  const bTok = s.balances.get(B)!;
  s = buyEarmark(s, C, 80_000_000n, 200_000_000n);
  s = buyEarmark(s, D, 80_000_000n, 200_000_000n);

  s = sell(s, A, aTok, 100_000_000n); // empty queue → A queues its appreciation
  // routed buys pay A directly (drain A's queue), re-pump price, add NO floor
  const head = () => s.queue.find((e) => e.owed > 0n);
  for (let i = 0; i < 3 && head(); i++) {
    s = buyRouted(s, A, 30_000_000n, A);
  }
  s = sell(s, B, bTok, 0n); // queue non-empty → headroom clamp must bind

  const floorTotal = [...s.earmarkFloor.values()].reduce((t, v) => t + v, 0n);
  assert(queueTotal(s) <= floorTotal, `queueTotal ${queueTotal(s)} must not exceed floorTotal ${floorTotal}`);
  console.log("4b ok: queue clamped to coverage headroom, never exceeds collateral");
}

// ── 5. creator with no earmark dumping into virtual liquidity gets NOTHING ──
{
  let s = freshDirect();
  const crTok = s.balances.get(CR)!;
  const before = s.poolXno;
  s = sell(s, CR, crTok, 1_000_000_000_000n);
  // no earmark, no prepaid, no other collateral → credited 0, all shaved back
  assert.equal(queueTotal(s), 0n);
  assert.equal(s.poolXno, before); // -out +out: reserve unchanged, price protected
  // and a minXno floor makes the dump fail outright
  let s2 = freshDirect();
  assert.throws(() => sell(s2, CR, s2.balances.get(CR)!, 0n, 1n), /slippage/);
  console.log("5 ok: creator can't rug — dumping the 5% into virtual reserves yields zero");
}

// ── 6. defection detection: signed-balance observation voids proportionally, cross-token ──
{
  let m: MultiState = multiEmpty();
  const T1 = "11".repeat(16);
  const T2 = "22".repeat(16);
  for (const t of [T1, T2]) {
    m = applyBlock(m, { tokenId: t, op: { kind: "launch", supply: SUPPLY, name: "", symbol: "", decimals: 6, image: "", direct: true }, sender: CR, height: next() });
    m = applyBlock(m, { tokenId: t, op: { kind: "seedLiq", xno: SEED_X, tokens: SEED_T }, sender: CR, height: next() });
    // A commits the SAME 100M as collateral in both tokens (each per-token
    // check passes in isolation — the cross-token observation must catch it)
    m = applyBlock(m, { tokenId: t, op: { kind: "buy", xno: 100_000_000n, minTokens: 0n, balanceAt: 100_000_000n }, sender: A, height: next() });
  }
  const f1 = m.get(T1)!.earmarkFloor.get(A)!;
  const f2 = m.get(T2)!.earmarkFloor.get(A)!;
  const tok1 = m.get(T1)!.balances.get(A)!;
  assert(f1 + f2 > 100_000_000n, "double-committed floors exceed the real balance");

  // the observation: A's signed balance is only 100M → prorate + void
  m = applyBlock(m, { tokenId: "", op: { kind: "balance", raw: 100_000_000n }, sender: A, height: next() });
  const g1 = m.get(T1)!.earmarkFloor.get(A) ?? 0n;
  const g2 = m.get(T2)!.earmarkFloor.get(A) ?? 0n;
  assert(g1 < f1 && g2 < f2);
  assert(g1 + g2 <= 100_000_000n, "post-void floors fit the observed balance");
  const kept1 = m.get(T1)!.balances.get(A) ?? 0n;
  assert(kept1 < tok1, "tokens voided proportionally");
  // a healthy balance observation is a no-op
  const before = stateRoot(m);
  m = applyBlock(m, { tokenId: "", op: { kind: "balance", raw: 10_000_000_000n }, sender: A, height: next() });
  assert.equal(stateRoot(m), before);
  console.log("6 ok: cross-token floor proration voids double-committed collateral");
}

// ── 7. determinism: identical event streams → identical roots ────────────────
{
  const run = () => {
    let hh = 0n;
    let m: MultiState = multiEmpty();
    const T = "33".repeat(16);
    const ops = [
      { tokenId: T, op: { kind: "launch", supply: SUPPLY, name: "", symbol: "", decimals: 6, image: "", direct: true } as const, sender: CR },
      { tokenId: T, op: { kind: "seedLiq", xno: SEED_X, tokens: SEED_T } as const, sender: CR },
      { tokenId: T, op: { kind: "buy", xno: 70_000_000n, minTokens: 0n, balanceAt: 100_000_000n } as const, sender: A },
      { tokenId: T, op: { kind: "buy", xno: 90_000_000n, minTokens: 0n, balanceAt: 200_000_000n } as const, sender: B },
      { tokenId: "", op: { kind: "balance", raw: 40_000_000n } as const, sender: A },
    ];
    for (const o of ops) m = applyBlock(m, { ...o, height: ++hh });
    return stateRoot(m);
  };
  assert.equal(run(), run());
  console.log("7 ok: deterministic roots");
}

console.log("✅ direct-settlement consensus tests passed");
