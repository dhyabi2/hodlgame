// Futures consensus tests — token-margined inverse positions.
//
// Executable invariants:
//  * era gate: unstamped / pre-era futures ops are invalid; history untouched;
//  * conservation: balances + staked + treasury + poolTokens + lockedMargin
//    == supply after every op (no token is ever created or destroyed);
//  * zero-sum pairs: one side's gain is exactly the other's loss (± the
//    closer's fee, which also stays inside the pair);
//  * loss is capped at the loser's margin (solvent by construction);
//  * FIFO matching with partial fills; self-matching is impossible;
//  * deterministic liquidation at maintenance on any price move;
//  * leverage and open-interest caps; canonical root ignores inactive futures.

import { strict as assert } from "node:assert";
import { applyOp, emptyState, type State } from "./state";
import { FUTURES_ERA, LONG, SHORT, MAX_LEVERAGE, lockedMargin, markPrice, pnlTokens } from "./futures";
import { encodeFragLinks, assembleFrag, isFragA } from "./fraglink";
import { encodeOpLink, decodeOpLink } from "./oplink";
import { stateRoot } from "./canonical";

const CR = "nano_creator";
const A = "nano_alice";
const B = "nano_bob";
const C = "nano_carol";
const T = FUTURES_ERA + 100;

let h = 0n;
const next = () => ++h;

function seeded(): State {
  let s = emptyState();
  s = applyOp(s, { kind: "launch", supply: 1_000_000_000_000n, name: "F", symbol: "F", decimals: 6, image: "" }, CR, next());
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: s.treasury }, CR, next());
  s = applyOp(s, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, A, next());
  s = applyOp(s, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, B, next());
  s = applyOp(s, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, C, next());
  return s;
}
const open = (s: State, who: string, side: 0 | 1, size: bigint, margin: bigint, ts = T) =>
  applyOp(s, { kind: "futOpen", side, size, margin }, who, next(), ts);
const close = (s: State, who: string, size = 0n, ts = T) => applyOp(s, { kind: "futClose", size }, who, next(), ts);
const bal = (s: State, a: string) => s.balances.get(a) ?? 0n;

function conserved(s: State) {
  let held = 0n;
  for (const v of s.balances.values()) held += v;
  for (const v of s.staked.values()) held += v;
  const total = held + s.treasury + s.poolTokens + lockedMargin(s.futures);
  assert.equal(total, s.supply, `conservation: ${total} != ${s.supply}`);
}

// ── 1. era gate + encoding round-trips ──────────────────────────────────────
{
  const s = seeded();
  assert.throws(() => applyOp(s, { kind: "futOpen", side: LONG, size: 1000n, margin: 1000n }, A, next()), /not active/);
  assert.throws(() => open(s, A, LONG, 1000n, 1000n, FUTURES_ERA - 1), /not active/);
  assert.throws(() => close(s, A, 0n, FUTURES_ERA - 1), /not active/);
  const tid = "ab".repeat(16);
  const [fa, fb] = encodeFragLinks(tid, { kind: "futOpen", side: SHORT, size: 123_456n, margin: 50_000n });
  assert.ok(isFragA(fa));
  const d = assembleFrag(fa, fb);
  assert.deepEqual(d, { tokenId: tid, op: { kind: "futOpen", side: 1, size: 123_456n, margin: 50_000n } });
  const bad = fb.slice(0, 30) + "05" + fb.slice(32); // side byte (body[30] = fragB[15]) out of range
  assert.throws(() => assembleFrag(fa, bad), /side|padding/);
  const c = decodeOpLink(encodeOpLink(tid, { kind: "futClose", size: 77n }));
  assert.deepEqual(c, { tokenId: tid, op: { kind: "futClose", size: 77n } });
  // pre-futures state has NO futures key in the root → identical to before
  const root1 = stateRoot(new Map([[tid, s]]));
  const s2 = { ...s, futures: { book: [], pairs: [], nextId: 0n } };
  assert.equal(stateRoot(new Map([[tid, s2]])), root1);
  console.log("1 ok: era gate + encodings + root stability");
}

// ── 2. resting order locks margin; cancel refunds; conservation ─────────────
{
  let s = seeded();
  const a0 = bal(s, A);
  s = open(s, A, LONG, 5_000_000n, 1_000_000n); // 5x, rests (no shorts)
  assert.equal(bal(s, A), a0 - 1_000_000n);
  assert.equal(s.futures.book.length, 1);
  assert.equal(s.futures.pairs.length, 0);
  conserved(s);
  assert.throws(() => open(s, A, LONG, 5_000_001n, 1_000_000n), /leverage/);
  assert.throws(() => open(s, A, LONG, 1n, a0 * 2n), /insufficient balance/);
  s = close(s, A); // cancel-all
  assert.equal(bal(s, A), a0);
  assert.equal(s.futures.book.length, 0);
  assert.throws(() => close(s, A), /nothing to close/);
  conserved(s);
  console.log("2 ok: resting order + cancel + conservation");
}

// ── 3. match, price moves, close: zero-sum with capped loss ─────────────────
{
  let s = seeded();
  const a0 = bal(s, A), b0 = bal(s, B);
  s = open(s, A, LONG, 4_000_000n, 1_000_000n);
  s = open(s, B, SHORT, 4_000_000n, 2_000_000n);
  assert.equal(s.futures.pairs.length, 1);
  assert.equal(s.futures.book.length, 0);
  const p = s.futures.pairs[0];
  assert.equal(p.long.account, A);
  assert.equal(p.short.account, B);
  assert.equal(p.entry, markPrice(s));
  conserved(s);
  // price up: a big buy by C
  const entry = p.entry;
  s = applyOp(s, { kind: "buy", xno: 300_000_000n, minTokens: 0n }, C, next());
  const mark = markPrice(s);
  assert.ok(mark > entry);
  const expect = pnlTokens(LONG, 4_000_000n, entry, mark);
  assert.ok(expect > 0n && expect <= 2_000_000n, `pnl ${expect}`);
  if (s.futures.pairs.length === 1) {
    s = close(s, A); // A closes → pays fee to B
    const fee = (4_000_000n * 50n) / 10_000n;
    assert.equal(bal(s, A), a0 + expect - fee);
    assert.equal(bal(s, B), b0 - expect + fee);
  } else {
    // short got liquidated at maintenance: A gains at most B's margin
    assert.ok(bal(s, A) - a0 <= 2_000_000n);
    assert.equal(bal(s, A) - a0, b0 - bal(s, B));
  }
  conserved(s);
  assert.equal(s.futures.pairs.length, 0);
  console.log("3 ok: match → price move → close, zero-sum");
}

// ── 4. liquidation on price move, loss capped at margin ─────────────────────
{
  let s = seeded();
  const a0 = bal(s, A), b0 = bal(s, B);
  s = open(s, A, LONG, 5_000_000n, 1_000_000n); // max leverage, thin margin
  s = open(s, B, SHORT, 5_000_000n, 5_000_000n);
  // crash the price: A dumps a big sell? A can't (margin locked). C sells.
  s = applyOp(s, { kind: "sell", tokens: bal(s, C), minXno: 0n }, C, next());
  assert.equal(s.futures.pairs.length, 0, "long liquidated by the sweep");
  const aLoss = a0 - bal(s, A);
  assert.ok(aLoss > 0n && aLoss <= 1_000_000n, `loss capped at margin: ${aLoss}`);
  assert.equal(bal(s, B) - b0, aLoss, "short received exactly the long's loss");
  conserved(s);
  console.log("4 ok: deterministic liquidation, loss ≤ margin");
}

// ── 5. FIFO partial fills, no self-match, OI cap ────────────────────────────
{
  let s = seeded();
  s = open(s, A, SHORT, 1_000_000n, 1_000_000n); // id 0
  s = open(s, B, SHORT, 3_000_000n, 3_000_000n); // id 1
  s = open(s, A, LONG, 500_000n, 500_000n); // must skip own short → fills against B
  assert.equal(s.futures.pairs.length, 1);
  assert.equal(s.futures.pairs[0].short.account, B);
  assert.equal(s.futures.pairs[0].size, 500_000n);
  assert.equal(s.futures.book.find((o) => o.account === B)!.size, 2_500_000n);
  s = open(s, C, LONG, 2_000_000n, 2_000_000n); // FIFO: A's 1M first, then 1M of B's
  assert.equal(s.futures.pairs.length, 3);
  assert.equal(s.futures.pairs[1].short.account, A);
  assert.equal(s.futures.pairs[2].short.account, B);
  assert.equal(s.futures.book.length, 1);
  conserved(s);
  assert.throws(() => open(s, C, LONG, s.supply / 4n, s.supply / 4n / MAX_LEVERAGE), /open interest|insufficient/);
  // partial close by size
  s = close(s, C, 1_500_000n);
  assert.equal(s.futures.pairs.length, 2);
  conserved(s);
  s = close(s, A);
  s = close(s, B);
  assert.equal(s.futures.pairs.length, 0);
  assert.equal(s.futures.book.length, 0);
  assert.equal(lockedMargin(s.futures), 0n);
  conserved(s);
  console.log("5 ok: FIFO partial fills, no self-match, caps, partial close");
}

// ── 6. determinism: same ops → same root; futures never touch XNO fields ────
{
  const run = () => {
    h = 0n;
    let s = seeded();
    s = open(s, A, LONG, 2_000_000n, 1_000_000n);
    s = open(s, B, SHORT, 2_000_000n, 1_000_000n);
    s = applyOp(s, { kind: "buy", xno: 50_000_000n, minTokens: 0n }, C, next());
    s = close(s, B);
    return s;
  };
  const x = run(), y = run();
  assert.equal(stateRoot(new Map([["t", x]])), stateRoot(new Map([["t", y]])));
  const base = seeded();
  assert.equal(x.earmark.size, base.earmark.size);
  assert.equal(x.queue.length, base.queue.length);
  assert.equal(x.rebateVault, base.rebateVault);
  console.log("6 ok: deterministic root; spot XNO invariants untouched");
}

console.log("✅ futures tests passed");
