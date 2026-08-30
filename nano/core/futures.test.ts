// Futures consensus tests — token-margined inverse positions.
//
// Executable invariants (each numbered group is one property):
//  * era gate: unstamped / pre-era / NaN-stamped futures ops are invalid;
//  * conservation: balances + staked + treasury + poolTokens + lockedMargin
//    == supply after every op (no token is ever created or destroyed);
//  * zero-sum pairs: one side's gain is exactly the other's loss (± the
//    closer's fee, which also stays inside the pair);
//  * loss is capped at the loser's margin (solvent by construction);
//  * FIFO matching with partial fills; self-matching is impossible;
//  * the reference price is VOLUME-anchored and contains no clock: identical
//    op sequences with wildly different timestamps produce identical state;
//  * one large trade can neither liquidate nor be cashed out; sustained
//    volume does move the reference;
//  * the signer's entry-price guard survives fixpoint deferral;
//  * anti-spam: no sub-minimum ("immortal") positions, bounded book/pairs;
//  * dust-chunked closes cannot round the loss or the fee away.

import { strict as assert } from "node:assert";
import { applyOp, applyVoid, emptyState, type State } from "./state";
import {
  FUTURES_ERA,
  LONG,
  SHORT,
  MAX_LEVERAGE,
  MAX_BOOK_SIDE,
  MAX_ORDERS_PER_ACCOUNT,
  CLOSE_FEE_BPS,
  lockedMargin,
  markPrice,
  refPrice,
  minPositionSize,
  pnlTokens,
} from "./futures";
import { encodeFragLinks, assembleFrag, isFragA } from "./fraglink";
import { encodeOpLink, decodeOpLink } from "./oplink";
import { stateRoot } from "./canonical";

const CR = "nano_creator";
const A = "nano_alice";
const B = "nano_bob";
const C = "nano_carol";
const T = FUTURES_ERA + 100;
const TID = "ab".repeat(16);

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
// A price bound is mandatory in consensus; "any price" is a huge cap for a
// long and 1 raw for a short.
const anyGuard = (side: 0 | 1) => (side === LONG ? 1n << 100n : 1n);
const open = (s: State, who: string, side: 0 | 1, size: bigint, margin: bigint, ts = T, guard = anyGuard(side)) =>
  applyOp(s, { kind: "futOpen", side, size, margin, guard }, who, next(), ts);
const close = (s: State, who: string, size = 0n, ts = T) => applyOp(s, { kind: "futClose", size }, who, next(), ts);
const buy = (s: State, who: string, xno: bigint, ts = T) => applyOp(s, { kind: "buy", xno, minTokens: 0n }, who, next(), ts);
const sell = (s: State, who: string, tokens: bigint, ts = T) => applyOp(s, { kind: "sell", tokens, minXno: 0n }, who, next(), ts);
const bal = (s: State, a: string) => s.balances.get(a) ?? 0n;
const M = 100_000_000n; // minPositionSize for this fixture (supply 1e12 / 1e4)

function conserved(s: State) {
  let held = 0n;
  for (const v of s.balances.values()) held += v;
  for (const v of s.staked.values()) held += v;
  const total = held + s.treasury + s.poolTokens + s.rebateVault + lockedMargin(s.futures);
  assert.equal(total, s.supply, `conservation: ${total} != ${s.supply}`);
}

// ── 1. era gate + encoding round-trips + root stability ─────────────────────
{
  const s = seeded();
  assert.equal(minPositionSize(s), M);
  const badStamps: (number | undefined)[] = [undefined, FUTURES_ERA - 1, NaN, Number.POSITIVE_INFINITY];
  for (const ts of badStamps) {
    assert.throws(
      () => applyOp(s, { kind: "futOpen", side: LONG, size: 5n * M, margin: M, guard: 1n << 100n }, A, next(), ts),
      /not active/,
      `futOpen must be invalid at stamp ${ts}`
    );
    assert.throws(() => applyOp(s, { kind: "futClose", size: 0n }, A, next(), ts), /not active/);
  }
  const [fa, fb] = encodeFragLinks(TID, { kind: "futOpen", side: SHORT, size: 123_456n, margin: 50_000n, guard: 987_654_321n });
  assert.ok(isFragA(fa));
  assert.deepEqual(assembleFrag(fa, fb), {
    tokenId: TID,
    op: { kind: "futOpen", side: 1, size: 123_456n, margin: 50_000n, guard: 987_654_321n },
  });
  const badSide = fb.slice(0, 30) + "05" + fb.slice(32); // side byte (body[30]) out of range
  assert.throws(() => assembleFrag(fa, badSide), /side|padding/);
  const badPad = fb.slice(0, 62) + "01"; // body[46] padding must stay zero
  assert.throws(() => assembleFrag(fa, badPad), /padding/);
  assert.throws(() => encodeFragLinks(TID, { kind: "futOpen", side: 7 as 0 | 1, size: M, margin: M, guard: 0n }), /side/);
  assert.deepEqual(decodeOpLink(encodeOpLink(TID, { kind: "futClose", size: 77n })), {
    tokenId: TID,
    op: { kind: "futClose", size: 77n },
  });
  // A token with no futures activity serializes with NO futures key at all →
  // every pre-futures root is byte-identical to before the feature existed.
  assert.equal(stateRoot(new Map([[TID, s]])), stateRoot(new Map([[TID, { ...s, futures: emptyState().futures }]])));
  console.log("1 ok: era gate (incl. NaN), encodings, root stability");
}

// ── 2. resting order locks margin; cancel refunds; input validation ─────────
{
  let s = seeded();
  const a0 = bal(s, A);
  s = open(s, A, LONG, 5n * M, M); // 5x, rests (no shorts)
  assert.equal(bal(s, A), a0 - M);
  assert.equal(s.futures.book.length, 1);
  assert.equal(s.futures.pairs.length, 0);
  conserved(s);
  assert.throws(() => open(s, A, LONG, 5n * M + 1n, M), /leverage/);
  assert.throws(() => open(s, A, LONG, M - 1n, M), /too small/);
  assert.throws(() => open(s, A, LONG, M, a0 * 2n), /insufficient balance/);
  assert.throws(() => applyOp(s, { kind: "futOpen", side: LONG, size: M, margin: M, guard: 0n }, A, next(), T), /guard required/);
  s = close(s, A); // cancel-all
  assert.equal(bal(s, A), a0);
  assert.equal(s.futures.book.length, 0);
  // Closing nothing is a NO-OP, never invalid — an invalid op would be
  // deferred by the fixpoint and fire against a later position.
  const before = stateRoot(new Map([[TID, { ...s, height: 0n }]]));
  s = close(s, A);
  assert.equal(stateRoot(new Map([[TID, { ...s, height: 0n }]])), before, "close-nothing changes nothing but the height");
  conserved(s);
  console.log("2 ok: resting order, cancel, validation, close-nothing is a no-op");
}

// ── 3. match, volume moves the reference, close: zero-sum ───────────────────
{
  let s = seeded();
  const a0 = bal(s, A), b0 = bal(s, B);
  s = open(s, A, LONG, 4n * M, M);
  s = open(s, B, SHORT, 4n * M, 2n * M);
  assert.equal(s.futures.pairs.length, 1);
  assert.equal(s.futures.book.length, 0);
  const p = s.futures.pairs[0];
  assert.equal(p.long.account, A);
  assert.equal(p.short.account, B);
  assert.equal(p.entry, markPrice(s));
  conserved(s);
  const entry = p.entry;
  // Sustained volume: several large buys drag the volume-anchored reference up.
  for (let i = 0; i < 6; i++) s = buy(s, C, 400_000_000n);
  assert.ok(markPrice(s) > entry, "spot rose");
  assert.ok(refPrice(s, s.futures) > entry, "reference followed the volume");
  if (s.futures.pairs.length === 1) {
    const settle = markPrice(s) < refPrice(s, s.futures) ? markPrice(s) : refPrice(s, s.futures);
    const expect = pnlTokens(LONG, 4n * M, entry, settle); // long closer gets the lower price
    assert.ok(expect > 0n, `long is in profit: ${expect}`);
    s = close(s, A);
    const fee = (4n * M * CLOSE_FEE_BPS) / 10_000n;
    assert.equal(bal(s, A), a0 + expect - fee);
    assert.equal(bal(s, B), b0 - expect + fee, "exactly zero-sum, fee included");
  } else {
    assert.equal(bal(s, A) - a0, b0 - bal(s, B), "liquidated: still zero-sum");
    assert.ok(bal(s, A) - a0 <= 2n * M, "winner can never take more than the loser locked");
  }
  conserved(s);
  assert.equal(s.futures.pairs.length, 0);
  console.log("3 ok: match → volume-driven reference → close, zero-sum");
}

// ── 4. liquidation, loss capped at margin ──────────────────────────────────
{
  let s = seeded();
  s = open(s, A, LONG, 5n * M, M); // max leverage, thin margin
  s = open(s, B, SHORT, 5n * M, 5n * M);
  // A sustained decline with real volume behind it: several holders dump in
  // turn, so the volume-anchored reference follows spot down and the sweep
  // eventually fires. (One trade alone cannot do this — see group 8.)
  for (const who of [C, CR, A, B]) {
    if (s.futures.pairs.length === 0) break;
    const held = bal(s, who);
    if (held > 0n) s = sell(s, who, held);
  }
  assert.equal(s.futures.pairs.length, 0, "long liquidated by the sweep");
  // The receipt is the ground truth for who paid what (balances also move
  // here because these accounts sold spot tokens too).
  const r = s.futures.settled[s.futures.settled.length - 1];
  assert.equal(r.kind, 1, "liquidation, not a voluntary close");
  assert.equal(r.closer, "");
  assert.equal(r.long, A);
  assert.equal(r.short, B);
  assert.ok(r.longPnl < 0n, "the long lost");
  assert.ok(-r.longPnl <= M, `loss capped at the long's margin: ${-r.longPnl} > ${M}`);
  conserved(s);
  console.log("4 ok: deterministic liquidation, loss ≤ margin");
}

// ── 5. FIFO partial fills, no self-match, caps, partial close ──────────────
{
  let s = seeded();
  s = open(s, A, SHORT, 1n * M, 1n * M); // id 0
  s = open(s, B, SHORT, 3n * M, 3n * M); // id 1
  s = open(s, A, LONG, 1n * M, 1n * M); // must skip own short → fills against B
  assert.equal(s.futures.pairs.length, 1);
  assert.equal(s.futures.pairs[0].short.account, B);
  assert.equal(s.futures.pairs[0].size, 1n * M);
  assert.equal(s.futures.book.find((o) => o.account === B)!.size, 2n * M);
  s = open(s, C, LONG, 2n * M, 2n * M); // FIFO: A's 1M first, then 1M of B's
  assert.equal(s.futures.pairs.length, 3);
  assert.equal(s.futures.pairs[1].short.account, A);
  assert.equal(s.futures.pairs[2].short.account, B);
  assert.equal(s.futures.book.length, 1);
  conserved(s);
  assert.throws(() => open(s, C, LONG, s.supply / 4n, s.supply / 4n / MAX_LEVERAGE), /open interest|insufficient/);
  const pairsBefore = s.futures.pairs.length;
  s = close(s, C, 1n * M + M / 2n); // partial close, FIFO through C's pairs
  assert.ok(s.futures.pairs.length < pairsBefore);
  conserved(s);
  s = close(s, A);
  s = close(s, B);
  s = close(s, C);
  assert.equal(s.futures.pairs.length, 0);
  assert.equal(s.futures.book.length, 0);
  assert.equal(lockedMargin(s.futures), 0n);
  conserved(s);
  console.log("5 ok: FIFO partial fills, no self-match, caps, partial close");
}

// ── 6. determinism + the spot/XNO invariants stay untouched ────────────────
{
  const run = () => {
    h = 0n;
    let s = seeded();
    s = open(s, A, LONG, 2n * M, M);
    s = open(s, B, SHORT, 2n * M, M);
    s = buy(s, C, 50_000_000n);
    s = close(s, B);
    return s;
  };
  const x = run(), y = run();
  assert.equal(stateRoot(new Map([["t", x]])), stateRoot(new Map([["t", y]])));
  const base = seeded();
  assert.equal(x.earmark.size, base.earmark.size);
  assert.equal(x.queue.length, base.queue.length);
  assert.equal(x.rebateVault, base.rebateVault);
  assert.equal(x.xnoCredit.size, base.xnoCredit.size);
  console.log("6 ok: deterministic root; spot XNO invariants untouched");
}

// ── 7. NO CLOCK: timestamps cannot change consensus state ──────────────────
// A block's `local_timestamp` is per-node and not signature-covered. If it fed
// the reference price, two replayers seeing times a second apart would compute
// different balances and different roots — breaking in-browser verification.
{
  const run = (stamps: number[]) => {
    h = 0n;
    let s = seeded();
    let i = 0;
    const t = () => stamps[i++ % stamps.length];
    s = open(s, A, LONG, 4n * M, M, t());
    s = open(s, B, SHORT, 4n * M, 2n * M, t());
    s = buy(s, C, 300_000_000n, t());
    s = sell(s, C, bal(s, C) / 2n, t());
    s = buy(s, C, 120_000_000n, t());
    s = close(s, A, 0n, t());
    return stateRoot(new Map([["t", s]]));
  };
  const slow = run([T, T + 1, T + 2, T + 3, T + 4, T + 5]);
  const fast = run([T + 900_000, T + 900_001, T + 1_800_000, T + 2_700_000, T + 3_600_000, T + 9_000_000]);
  assert.equal(slow, fast, "identical ops at wildly different times → identical root");
  console.log("7 ok: reference is volume-anchored — no timestamp reaches consensus");
}

// ── 8. one large trade can neither liquidate nor be cashed out ─────────────
{
  let s = seeded();
  const a0 = bal(s, A), b0 = bal(s, B);
  s = open(s, A, LONG, 5n * M, M); // 5x long, thin margin
  s = open(s, B, SHORT, 5n * M, 5n * M);
  const entry = s.futures.pairs[0].entry;
  // ONE enormous dump: concentrate the float in a single wallet (a transfer
  // moves no price), then sell it all in a single op. Spot collapses well past
  // the long's bankruptcy price.
  s = applyOp(s, { kind: "transfer", to: C, amount: bal(s, CR) }, CR, next());
  s = sell(s, C, bal(s, C));
  assert.ok(markPrice(s) < (entry * 80n) / 100n, `spot crashed hard: ${(markPrice(s) * 100n) / entry}%`);
  assert.equal(s.futures.pairs.length, 1, "a single trade cannot liquidate: the reference barely moved");
  // …and the short cannot cash the crash: closing settles at the price worse
  // for the closer, which is the (still high) reference — so the manipulated
  // spot buys them only a fraction of what it appears to be worth.
  const pair = s.futures.pairs[0];
  const atSpot = -pnlTokens(LONG, pair.size, pair.entry, markPrice(s)); // if spot priced the close
  const sTry = close(s, B, 0n, T + 1);
  const rr = sTry.futures.settled[sTry.futures.settled.length - 1];
  const got = -rr.longPnl; // what the short actually took
  assert.ok(atSpot > 0n && got < atSpot / 2n, `spot would pay ${atSpot}, the reference paid ${got}`);
  assert.ok(got <= M, "and never more than the long's whole margin");
  conserved(sTry);
  void a0; void b0;
  console.log("8 ok: a single large trade moves spot, not the reference");
}

// ── 9. taker-adverse entry + the signer's price guard ──────────────────────
{
  let s = seeded();
  s = open(s, A, SHORT, 2n * M, 2n * M); // rests
  for (let i = 0; i < 4; i++) s = buy(s, C, 300_000_000n); // drag spot AND reference up
  const spot = markPrice(s), ref = refPrice(s, s.futures);
  assert.ok(spot !== ref, "spot and reference have separated");
  const hi = spot > ref ? spot : ref, lo = spot > ref ? ref : spot;
  // A long taker pays the HIGHER of the two.
  const s2 = open(s, B, LONG, 2n * M, 2n * M);
  assert.equal(s2.futures.pairs[0].entry, hi, "long taker gets the adverse (higher) price");
  // The same open with a guard below that price is rejected outright — this is
  // what makes a fixpoint-DEFERRED open safe: it can never fill at a price the
  // signer did not accept.
  assert.throws(() => open(s, B, LONG, 2n * M, 2n * M, T, hi - 1n), /entry price guard/);
  // A generous guard passes.
  const s3 = open(s, B, LONG, 2n * M, 2n * M, T, hi + 1n);
  assert.equal(s3.futures.pairs.length, 1);
  // A short taker gets the LOWER of the two.
  let s4 = seeded();
  s4 = open(s4, A, LONG, 2n * M, 2n * M);
  for (let i = 0; i < 4; i++) s4 = buy(s4, C, 300_000_000n);
  const lo4 = markPrice(s4) < refPrice(s4, s4.futures) ? markPrice(s4) : refPrice(s4, s4.futures);
  s4 = open(s4, B, SHORT, 2n * M, 2n * M);
  assert.equal(s4.futures.pairs[0].entry, lo4, "short taker gets the adverse (lower) price");
  assert.ok(lo <= hi);
  conserved(s2);
  console.log("9 ok: taker-adverse entry, price guard honoured");
}

// ── 10. receipts are exact, unique and bounded ─────────────────────────────
{
  let s = seeded();
  const a0 = bal(s, A), b0 = bal(s, B);
  s = open(s, A, LONG, 2n * M, M);
  s = open(s, B, SHORT, 2n * M, M);
  s = close(s, B, 0n, T + 1);
  assert.equal(s.futures.settled.length, 1);
  const r = s.futures.settled[0];
  assert.equal(r.kind, 0);
  assert.equal(r.closer, B);
  assert.equal(r.long, A);
  assert.equal(r.short, B);
  assert.equal(r.size, 2n * M);
  assert.equal(r.seq, 0n);
  assert.equal(bal(s, A) - a0, r.longPnl, "long's receipt matches its balance change");
  assert.equal(bal(s, B) - b0, -r.longPnl, "short's receipt is the mirror");
  // Bounded tape, and every receipt carries a unique monotone seq so a derived
  // history can never mistake two identical settlements for one.
  const seqs = new Set<string>();
  for (let i = 0; i < 45; i++) {
    s = open(s, A, LONG, M, M, T + 10 + i);
    s = open(s, B, SHORT, M, M, T + 10 + i);
    s = close(s, A, 0n, T + 11 + i);
  }
  assert.ok(s.futures.settled.length <= 32, "tape bounded");
  for (const x of s.futures.settled) seqs.add(x.seq.toString());
  assert.equal(seqs.size, s.futures.settled.length, "seq unique across the tape");
  assert.ok(s.futures.nextSeq > 40n, "seq keeps counting past the tape window");
  conserved(s);
  console.log("10 ok: receipts exact, uniquely sequenced, bounded");
}

// ── 11. anti-spam: no sub-minimum positions, bounded book ──────────────────
// Nano is feeless, so anything that grows replayed state per block must be
// capped by COUNT. A position below minSize has maint == 0 and pnl == 0: it
// could never be liquidated and would sit in consensus state forever.
{
  let s = seeded();
  // A partial fill may never whittle a maker below minSize…
  s = open(s, A, SHORT, 2n * M, 2n * M);
  s = open(s, B, LONG, M + M / 2n, M + M / 2n); // would leave the maker 0.5M
  assert.equal(s.futures.pairs.length, 0, "sub-minimum residue → no match at all");
  assert.equal(s.futures.book.find((o) => o.account === A)!.size, 2n * M, "maker untouched");
  for (const o of s.futures.book) assert.ok(o.size >= M, "every resting order is liquidatable-sized");
  for (const p of s.futures.pairs) assert.ok(p.size >= M, "every pair is liquidatable-sized");
  conserved(s);

  // …and the book is bounded per side and per account.
  let t2 = seeded();
  const many = ["x1", "x2", "x3"];
  for (const who of many) t2 = applyOp(t2, { kind: "transfer", to: who, amount: 50n * M }, A, next());
  for (const who of many) {
    for (let i = 0; i < 5; i++) {
      try { t2 = open(t2, who, LONG, M, M); } catch { /* cap reached */ }
    }
    const mine = t2.futures.book.filter((o) => o.account === who).length;
    assert.ok(mine <= MAX_ORDERS_PER_ACCOUNT, `per-account cap: ${mine}`);
  }
  assert.ok(t2.futures.book.filter((o) => o.side === LONG).length <= MAX_BOOK_SIDE);
  conserved(t2);
  console.log("11 ok: no sub-minimum positions; book bounded per side and account");
}

// ── 12. dust-chunked closes cannot round the loss or the fee away ──────────
// pnl, the prorated margins and the close fee all floor. Closing a losing pair
// in tiny slices would round every one of them to zero, letting the loser walk
// away paying neither. A partial close must take AND leave at least minSize.
{
  const setup = () => {
    h = 0n;
    let s = seeded();
    s = open(s, A, LONG, 20n * M, 4n * M);
    s = open(s, B, SHORT, 20n * M, 20n * M);
    for (let i = 0; i < 3; i++) s = sell(s, C, bal(s, C) / 3n > 0n ? bal(s, C) / 3n : 1n);
    return s;
  };
  const oneShot = setup();
  const a0 = bal(oneShot, A);
  const closedOnce = close(oneShot, A, 0n, T + 1);
  const lossOneShot = a0 - bal(closedOnce, A);

  let chunked = setup();
  for (let i = 0; i < 300 && chunked.futures.pairs.length > 0; i++) chunked = close(chunked, A, 8n, T + 1);
  const lossChunked = a0 - bal(chunked, A);
  assert.equal(chunked.futures.pairs.length, 0, "a dust close settles the whole pair, not a free slice");
  assert.equal(lossChunked, lossOneShot, "chunking changes nothing: same loss, same fee");
  conserved(chunked);
  console.log("12 ok: dust-chunked close pays exactly the same as one shot");
}

// ── 13. a reserve move with NO XNO volume still moves the reference ────────
// `addLiq(xno = 0, tokens = …)` is creator-only and free, and repositions spot
// without moving a single raw of XNO. Weighting the reference on XNO volume
// alone would leave it stale, and `worseFor` would hand that entire gap to a
// resting maker — the exact manipulation the reference exists to prevent.
{
  let s = emptyState();
  s = applyOp(s, { kind: "launch", supply: 1_000_000_000_000n, name: "F", symbol: "F", decimals: 6, image: "" }, CR, next());
  const half = s.treasury / 2n;
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: half }, CR, next());
  s = applyOp(s, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, A, next());
  s = applyOp(s, { kind: "buy", xno: 100_000_000n, minTokens: 0n }, B, next());
  s = open(s, A, LONG, 4n * M, M);
  s = open(s, B, SHORT, 4n * M, 4n * M);
  const markBefore = refPrice(s, s.futures);
  const xnoBefore = s.poolXno;
  s = applyOp(s, { kind: "addLiq", xno: 0n, tokens: s.treasury }, CR, next());
  assert.equal(s.poolXno, xnoBefore, "no XNO moved at all");
  const spotAfter = markPrice(s);
  assert.ok(spotAfter < markBefore, "spot was repositioned downward for free");
  const markAfter = refPrice(s, s.futures);
  assert.ok(markAfter < markBefore, "the reference followed — it is not stale");
  const closed = (markBefore - markAfter) * 100n / (markBefore - spotAfter);
  assert.ok(closed >= 50n, `reference closed ${closed}% of a zero-volume gap`);
  conserved(s);
  console.log("13 ok: a zero-XNO reserve move still moves the reference");
}

// ── 14. futures margin cannot cloak a Direct-Settlement position ───────────
// The earmark floor ratchets down to the sell-value of the holder's position.
// If margin were invisible to that, one futOpen with margin = whole balance
// would ratchet the floor to zero and free the holder to spend the XNO
// collateral that every other seller's quote is backed by (SPEC §8).
{
  const SUPPLY = 1_000_000_000_000n;
  let s = emptyState();
  s = applyOp(s, { kind: "launch", supply: SUPPLY, name: "D", symbol: "D", decimals: 6, image: "", direct: true }, CR, next());
  s = applyOp(s, { kind: "seedLiq", xno: 1_000_000_000n, tokens: 100_000_000_000n }, CR, next());
  s = applyOp(s, { kind: "buy", xno: 50_000_000n, minTokens: 0n, balanceAt: 60_000_000n }, A, next());
  const floorBefore = s.earmarkFloor.get(A) ?? 0n;
  assert.ok(floorBefore > 0n, "A committed real collateral");
  const held = bal(s, A);
  assert.ok(held >= M, "A holds enough to open a position");
  s = open(s, A, LONG, M, held); // margin = A's ENTIRE token balance
  assert.equal(bal(s, A), 0n, "the whole position is now locked as margin");
  // Any later price-moving op runs the ratchet.
  s = applyOp(s, { kind: "buy", xno: 10_000_000n, minTokens: 0n, balanceAt: 20_000_000n }, B, next());
  const floorAfter = s.earmarkFloor.get(A) ?? 0n;
  assert.ok(floorAfter > 0n, `floor must not collapse: ${floorBefore} → ${floorAfter}`);
  assert.equal(floorAfter, floorBefore, "and it should not move at all — the position is unchanged");
  // Defection is still punished: dropping the real balance below the floor
  // voids the position proportionally, INCLUDING the margin.
  const lockedBefore = lockedMargin(s.futures);
  // (a `balance` observation routes through the multi-token layer, which
  //  prorates the floor across tokens and calls applyVoid — invoked directly here)
  s = applyVoid(s, A, floorAfter / 2n);
  assert.ok(lockedMargin(s.futures) < lockedBefore, "margin is voided along with the rest");
  conserved(s);
  console.log("14 ok: futures margin cannot hide a direct-token position");
}

console.log("✅ futures tests passed");
