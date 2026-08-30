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
import { FUTURES_ERA, LONG, SHORT, MAX_LEVERAGE, lockedMargin, markPrice, pnlTokens, twapPrice } from "./futures";
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
  const s2 = { ...s, futures: emptyState().futures };
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
  // price up: a big buy by C, then HELD for a full TWAP window (a later op
  // stamps the end of the holding period) so the move is real, not a blip.
  const entry = p.entry;
  s = applyOp(s, { kind: "buy", xno: 300_000_000n, minTokens: 0n }, C, next(), T + 601);
  s = applyOp(s, { kind: "buy", xno: 1n, minTokens: 0n }, C, next(), T + 1202);
  const spotNow = markPrice(s);
  assert.ok(spotNow > entry);
  if (s.futures.pairs.length === 1) {
    const tw = twapPrice(s, s.futures, T + 1203);
    const settle = spotNow < tw ? spotNow : tw; // long closer gets the lower
    const expect = pnlTokens(LONG, 4_000_000n, entry, settle);
    assert.ok(expect > 0n && expect <= 2_000_000n, `pnl ${expect}`);
    s = close(s, A, 0n, T + 1203); // A closes → pays fee to B
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

// ── 7. Block 2: TWAP reference — a one-op pump cannot liquidate or pay out ──
{
  // Sampling starts at the first futOpen; nothing is recorded before that.
  let s = seeded();
  // C pumps hard first (so dumping it all later crashes spot by ~70%).
  s = applyOp(s, { kind: "buy", xno: 1_000_000_000n, minTokens: 0n }, C, next(), T - 1);
  assert.equal(s.futures.samples.length, 0, "no samples before activity");
  const tid = "cd".repeat(16);
  const rootBefore = stateRoot(new Map([[tid, s]]));
  assert.equal(rootBefore, stateRoot(new Map([[tid, { ...s, futures: emptyState().futures }]])), "root untouched");

  const t0 = T;
  const a0 = bal(s, A), b0 = bal(s, B); // pre-open balances
  s = open(s, A, LONG, 5_000_000n, 1_000_000n, t0); // max leverage
  s = open(s, B, SHORT, 5_000_000n, 5_000_000n, t0);
  assert.equal(s.futures.samples.length, 1, "first open records a sample");
  const entry = s.futures.pairs[0].entry;
  // One second later a whale crashes spot by ~40% inside a single op: spot says
  // "liquidate the long", the 10-minute TWAP still says the old price → no
  // liquidation, no payout to the short.
  s = applyOp(s, { kind: "sell", tokens: bal(s, C), minXno: 0n }, C, next(), t0 + 1);
  assert.ok(markPrice(s) < (entry * 70n) / 100n, "spot crashed");
  assert.equal(s.futures.pairs.length, 1, "TWAP blocks the one-op liquidation");
  // The short cannot cash the crash either: closing settles at the closer-
  // adverse price (max of spot, twap ≈ entry) → ~zero pnl, minus the fee.
  const sTry = close(s, B, 0n, t0 + 2);
  assert.ok(bal(sTry, B) - b0 <= 0n, "short gains nothing from a one-op crash");
  // Same crash held for the whole window (others could have sold into it)
  // does liquidate — at the price more favourable to the loser, loss ≤ margin.
  s = applyOp(s, { kind: "buy", xno: 1n, minTokens: 0n }, C, next(), t0 + 601);
  assert.equal(s.futures.pairs.length, 0, "sustained move liquidates");
  const aLoss = a0 - bal(s, A);
  assert.ok(aLoss > 0n && aLoss <= 1_000_000n, `loss capped: ${aLoss}`);
  assert.equal(bal(s, B) - b0, aLoss, "zero-sum");
  conserved(s);
  console.log("7 ok: TWAP — one-op pump is powerless, sustained move settles");
}

// ── 8. Block 2: taker-adverse entry, samples bounded, pool-depth OI cap ─────
{
  let s = seeded();
  s = open(s, A, SHORT, 1_000_000n, 1_000_000n, T);
  // pump spot up, then a long taker enters: entry = max(spot, twap) = spot
  s = applyOp(s, { kind: "buy", xno: 200_000_000n, minTokens: 0n }, C, next(), T + 5);
  const spot = markPrice(s);
  const tw = twapPrice(s, s.futures, T + 6);
  assert.ok(tw < spot, "twap lags the pump");
  s = open(s, B, LONG, 1_000_000n, 1_000_000n, T + 6);
  assert.equal(s.futures.pairs[0].entry, spot, "long taker pays the higher (spot) price");
  // a short taker gets the LOWER of spot/twap
  s = applyOp(s, { kind: "sell", tokens: bal(s, C) / 2n, minXno: 0n }, C, next(), T + 7);
  s = open(s, A, LONG, 500_000n, 500_000n, T + 8); // rests
  const sp2 = markPrice(s);
  const tw2 = twapPrice(s, s.futures, T + 9);
  s = open(s, C, SHORT, 500_000n, 500_000n, T + 9);
  assert.equal(s.futures.pairs[1].entry, sp2 < tw2 ? sp2 : tw2, "short taker gets the lower price");
  // samples bounded and pruned
  for (let i = 0; i < 200; i++) s = applyOp(s, { kind: "buy", xno: 1000n, minTokens: 0n }, C, next(), T + 10 + i);
  assert.ok(s.futures.samples.length <= 64, "bounded samples");
  s = applyOp(s, { kind: "buy", xno: 1000n, minTokens: 0n }, C, next(), T + 5000);
  assert.ok(s.futures.samples.length <= 2, "old samples pruned past the window");
  // depth-aware cap: OI ≤ 50% of pool token reserve
  const capPool = s.poolTokens / 2n;
  assert.throws(() => open(s, B, SHORT, capPool + 1n, capPool / 4n + 1n, T + 5001), /open interest|insufficient/);
  conserved(s);
  console.log("8 ok: taker-adverse entry, bounded samples, depth-aware OI cap");
}

console.log("✅ futures tests passed");
