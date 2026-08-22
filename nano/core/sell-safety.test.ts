// Consensus safety proof for sells: no selling without balance, and no
// double-spending. Covers BOTH pooled and direct (zero-custody) tokens, since
// the balance guard sits before the branch. These are the invariants a trader's
// funds depend on, verified against the real applyOp.

import { strict as assert } from "node:assert";
import { applyOp, emptyState, InvalidOp, type State } from "./state";

const CR = "nano_creator";
const A = "nano_alice";
const B = "nano_bob";
const SUPPLY = 1_000_000_000_000n;
let h = 0n;
const next = () => ++h;

function launched(direct: boolean): State {
  let s = emptyState();
  s = applyOp(s, { kind: "launch", supply: SUPPLY, name: "T", symbol: "T", decimals: 6, image: "", direct }, CR, next());
  // seed reserves so sells have a curve (pooled: value-bound in indexer; here we
  // set them directly via seedLiq — creator only).
  s = applyOp(s, { kind: "seedLiq", xno: 100_000_000n, tokens: 500_000_000n }, CR, next());
  return s;
}

function throws(fn: () => void, msg: string) {
  assert.throws(fn, (e: any) => e instanceof InvalidOp && /insufficient balance|zero tokens/.test(e.message), msg);
}

for (const direct of [false, true]) {
  const label = direct ? "direct" : "pooled";

  // 1. Selling with ZERO balance is rejected.
  {
    const s = launched(direct);
    throws(() => applyOp(s, { kind: "sell", tokens: 1n, minXno: 0n, balanceAt: 0n }, A, next()), `${label}: zero-balance sell must throw`);
    console.log(`1 ok (${label}): sell with no balance rejected`);
  }

  // 2. Selling MORE than you hold is rejected (no overdraft).
  {
    let s = launched(direct);
    // give A a real balance via a buy (direct: self-earmark; pooled: buy)
    s = applyOp(s, { kind: "buy", xno: 10_000_000n, minTokens: 0n, ...(direct ? { balanceAt: 100_000_000n } : {}) }, A, next());
    const bal = s.balances.get(A)!;
    assert(bal > 0n, `${label}: A should hold tokens`);
    throws(() => applyOp(s, { kind: "sell", tokens: bal + 1n, minXno: 0n, balanceAt: 100_000_000n }, A, next()), `${label}: overdraft sell must throw`);
    console.log(`2 ok (${label}): selling more than held rejected`);
  }

  // 3. NO DOUBLE-SPEND: sell the full balance, then a second sell of any amount
  //    is rejected because the first debited the tokens.
  {
    let s = launched(direct);
    s = applyOp(s, { kind: "buy", xno: 10_000_000n, minTokens: 0n, ...(direct ? { balanceAt: 100_000_000n } : {}) }, A, next());
    const bal = s.balances.get(A)!;
    s = applyOp(s, { kind: "sell", tokens: bal, minXno: 0n, balanceAt: 100_000_000n }, A, next());
    assert.equal(s.balances.get(A) ?? 0n, 0n, `${label}: balance zero after full sell`);
    throws(() => applyOp(s, { kind: "sell", tokens: 1n, minXno: 0n, balanceAt: 100_000_000n }, A, next()), `${label}: second sell of already-sold tokens must throw`);
    console.log(`3 ok (${label}): no double-spend — sold tokens can't be sold again`);
  }

  // 4. Two partial sells debit cumulatively; the moment they'd exceed the
  //    remaining balance, the sell throws (can't split a double-spend).
  {
    let s = launched(direct);
    s = applyOp(s, { kind: "buy", xno: 10_000_000n, minTokens: 0n, ...(direct ? { balanceAt: 100_000_000n } : {}) }, A, next());
    const bal = s.balances.get(A)!;
    const half = bal / 2n;
    s = applyOp(s, { kind: "sell", tokens: half, minXno: 0n, balanceAt: 100_000_000n }, A, next());
    const rem = s.balances.get(A)!;
    assert.equal(rem, bal - half, `${label}: partial sell debits exactly`);
    throws(() => applyOp(s, { kind: "sell", tokens: rem + 1n, minXno: 0n, balanceAt: 100_000_000n }, A, next()), `${label}: can't sell more than the remainder`);
    // selling the exact remainder is fine
    s = applyOp(s, { kind: "sell", tokens: rem, minXno: 0n, balanceAt: 100_000_000n }, A, next());
    assert.equal(s.balances.get(A) ?? 0n, 0n, `${label}: fully drained after remainder sell`);
    console.log(`4 ok (${label}): cumulative debits — remainder can't be over-sold`);
  }

  // 5. Purity: a REJECTED sell must not mutate the prior state (so a failed op
  //    can't leak balance changes that a later op could exploit).
  {
    let s = launched(direct);
    s = applyOp(s, { kind: "buy", xno: 10_000_000n, minTokens: 0n, ...(direct ? { balanceAt: 100_000_000n } : {}) }, A, next());
    const before = s.balances.get(A)!;
    const poolBefore = s.poolTokens;
    try { applyOp(s, { kind: "sell", tokens: before + 1000n, minXno: 0n, balanceAt: 100_000_000n }, A, next()); } catch {}
    assert.equal(s.balances.get(A), before, `${label}: rejected sell left balance untouched`);
    assert.equal(s.poolTokens, poolBefore, `${label}: rejected sell left pool untouched`);
    console.log(`5 ok (${label}): a rejected sell mutates nothing (pure)`);
  }
}

console.log("✅ sell-safety consensus proof passed (no zero-balance sell, no double-spend, pure on reject)");
