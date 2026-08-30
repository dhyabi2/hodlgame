// HodlGame Futures — token-margined (inverse) perpetual positions.
//
// WHY THIS IS THE ONLY TRUSTLESS DERIVATIVE ON NANO: the chain cannot seize
// XNO from anyone, but a HodlGame token exists ONLY as replay state. Margin
// posted in the token is therefore enforceable by consensus — a loss is a
// balance move inside `State`, no escrow, no operator key, no oracle. The
// settlement price is the token's own replay-computed spot (virtual reserves),
// so every payoff is a pure function of chain history that anyone re-derives
// in-browser. Nothing here touches XNO or the spot invariants (earmarks,
// queue == unpaid appreciation): futures are a closed loop in token units.
//
// Model (BitMEX-style inverse contract, denominated in tokens):
//   spot   = poolXno × PRECISION / poolTokens            (XNO-raw per token, ×1e12)
//   long   pnl(tokens) = size × (price − entry) / price
//   short  pnl(tokens) = size × (entry − price) / price
//   |loss| is capped at the loser's margin (bankruptcy price) — a winner can
//   never be owed more than the counterparty actually locked, so the system is
//   solvent by construction with no insurance fund. Settlement never trades
//   against the pool, so liquidations cannot cascade through the price.
//
// MANIPULATION RESISTANCE (Block 2). Spot alone can be pumped inside one op
// for ~2% swap fees, and op-count windows are free to spam on a feeless chain.
// So the reference is a TIME-weighted average (TWAP_WINDOW seconds) over
// timestamped samples of spot — the same network timestamps that already
// order blocks and gate eras. Holding a pump for the whole window means every
// other holder can sell into it; that is the manipulator's real cost. Rules:
//   entry  — the TAKER gets the worse of (spot, twap) for their side;
//   close  — the pair settles at the worse of (spot, twap) for the CLOSER;
//   liquidation — fires only when the loser is below maintenance at BOTH spot
//   and twap, and settles at the price more favourable to the loser.
// Sampling starts at a token's first futOpen (never before), so every
// pre-futures root is byte-identical.
//
// Positions are strictly PAIRED: an open matches FIFO against resting
// opposite-side orders (partial fills allowed); the rest waits in the book.
// Closing one side closes the pair symmetrically (the counterparty is settled
// at the same price) — the closer pays CLOSE_FEE to the party it closed.
//
// Era-gated: futures ops stamped before FUTURES_ERA are invalid, and the sweep
// is a no-op while a token has no pairs — so replay of all pre-existing history
// is byte-identical (verified against the full production ledger).

import { BPS, PRECISION, InvalidOp, type State } from "./state";

/** Era boundary (unix seconds, 2026-08-30 14:26:40 UTC). Futures ops stamped
 * before this — or unstamped — are invalid. Published constant. */
export const FUTURES_ERA = 1_788_100_000;
export const MAX_LEVERAGE = 5n; // size ≤ margin × 5
export const MAINT_BPS = 500n; // liquidate when equity ≤ 5% of size
export const CLOSE_FEE_BPS = 50n; // 0.5% of closed size, closer → counterparty
export const MAX_OI_BPS = 2_500n; // each side's open interest ≤ 25% of supply
export const MAX_OI_POOL_BPS = 5_000n; // … and ≤ 50% of the token reserve (depth-aware)
export const TWAP_WINDOW = 600; // seconds
export const MAX_SAMPLES = 64; // bounded state; oldest in-window samples dropped first

export type FutSide = 0 | 1; // 0 = long, 1 = short
export const LONG: FutSide = 0;
export const SHORT: FutSide = 1;

export interface FutOrder {
  id: bigint;
  account: string;
  side: FutSide;
  size: bigint; // remaining unmatched size (tokens notional)
  margin: bigint; // tokens locked for the remaining size
}

export interface FutPair {
  id: bigint;
  size: bigint;
  entry: bigint; // price at match (× PRECISION)
  long: { account: string; margin: bigint };
  short: { account: string; margin: bigint };
}

export interface FutSample {
  t: number; // network timestamp (seconds), non-decreasing
  price: bigint; // spot at that op (× PRECISION)
}

export interface FutState {
  book: FutOrder[]; // resting orders, FIFO per side
  pairs: FutPair[]; // open matched positions, ascending id
  nextId: bigint;
  samples: FutSample[]; // spot history for the TWAP (only once active)
}

export function emptyFutures(): FutState {
  return { book: [], pairs: [], nextId: 0n, samples: [] };
}

export function cloneFutures(f: FutState): FutState {
  return {
    book: f.book.map((o) => ({ ...o })),
    pairs: f.pairs.map((p) => ({ ...p, long: { ...p.long }, short: { ...p.short } })),
    nextId: f.nextId,
    samples: f.samples.map((x) => ({ ...x })),
  };
}

/** Has this token ever had futures activity? (Controls canonical inclusion
 * and TWAP sampling.) */
export function futuresActive(f: FutState): boolean {
  return f.nextId > 0n || f.book.length > 0 || f.pairs.length > 0;
}

/** Spot from the virtual reserves (× PRECISION). 0 when unpriced. */
export function markPrice(s: State): bigint {
  if (s.poolXno <= 0n || s.poolTokens <= 0n) return 0n;
  return (s.poolXno * PRECISION) / s.poolTokens;
}

/** Record a spot sample at `t` (no-op without a timestamp or before the token
 * is active). Keeps samples time-monotone and bounded. */
export function recordSample(s: State, f: FutState, t: number | undefined): void {
  if (t == null || !futuresActive(f)) return;
  const price = markPrice(s);
  if (price <= 0n) return;
  const last = f.samples[f.samples.length - 1];
  const tt = last && t < last.t ? last.t : t; // deferred ops may carry an older stamp
  if (last && last.t === tt) last.price = price; // same second → latest wins
  else f.samples.push({ t: tt, price });
  pruneSamples(f, tt);
}

function pruneSamples(f: FutState, now: number) {
  const ws = now - TWAP_WINDOW;
  // keep ONE sample at/before the window start (price in force at ws)
  let firstKeep = 0;
  for (let i = 0; i < f.samples.length; i++) if (f.samples[i].t <= ws) firstKeep = i;
  if (firstKeep > 0) f.samples = f.samples.slice(firstKeep);
  while (f.samples.length > MAX_SAMPLES) f.samples.splice(1, 1); // drop oldest in-window
}

/** Time-weighted average spot over [now − TWAP_WINDOW, now]; each sample holds
 * until the next, and the FIRST sample is extended back to the window start
 * (the price at activation is assumed to have been in force for a full window,
 * so the reference is never dominated by a few seconds of fresh history).
 * Falls back to spot when there is no usable history. */
export function twapPrice(s: State, f: FutState, now: number | undefined): bigint {
  const spot = markPrice(s);
  if (now == null || f.samples.length === 0) return spot;
  const last = f.samples[f.samples.length - 1];
  const end = now < last.t ? last.t : now;
  const ws = end - TWAP_WINDOW;
  let num = 0n;
  let den = 0n;
  for (let i = 0; i < f.samples.length; i++) {
    const a = i === 0 ? ws : f.samples[i].t > ws ? f.samples[i].t : ws;
    const b = i + 1 < f.samples.length ? f.samples[i + 1].t : end;
    const w = b - a;
    if (w <= 0) continue;
    num += f.samples[i].price * BigInt(w);
    den += BigInt(w);
  }
  return den > 0n ? num / den : spot;
}

/** Price that is WORSE for `side` (long wants low entry/high exit — the
 * adverse pick is the opposite). `forExit`: true when the side is closing. */
function worseFor(side: FutSide, forExit: boolean, spot: bigint, twap: bigint): bigint {
  const lo = spot < twap ? spot : twap;
  const hi = spot < twap ? twap : spot;
  // long entering wants low → adverse = hi; long exiting wants high → adverse = lo
  if (side === LONG) return forExit ? lo : hi;
  return forExit ? hi : lo;
}

/** Signed pnl in tokens for `side` on `size` from `entry` to `price`. */
export function pnlTokens(side: FutSide, size: bigint, entry: bigint, price: bigint): bigint {
  if (price <= 0n) return 0n;
  const diff = side === LONG ? price - entry : entry - price;
  return (size * diff) / price;
}

function get(m: Map<string, bigint>, k: string): bigint {
  return m.get(k) ?? 0n;
}
function set(m: Map<string, bigint>, k: string, v: bigint) {
  if (v === 0n) m.delete(k);
  else m.set(k, v);
}

function sideOI(f: FutState, side: FutSide): bigint {
  let t = 0n;
  for (const o of f.book) if (o.side === side) t += o.size;
  for (const p of f.pairs) t += p.size; // every pair has one leg on each side
  return t;
}

/** Sum of tokens locked as futures margin (book + pairs) — conservation input. */
export function lockedMargin(f: FutState): bigint {
  let t = 0n;
  for (const o of f.book) t += o.margin;
  for (const p of f.pairs) t += p.long.margin + p.short.margin;
  return t;
}

/** Settle one pair (or a `portion` of it) at `price`, returning tokens to both
 * parties' balances. `closer` (if given) pays CLOSE_FEE on the portion to the
 * other side. Loss is capped at the loser's prorated margin. Mutates `s`. */
function settlePortion(s: State, p: FutPair, portion: bigint, price: bigint, closer?: string) {
  const lm = (p.long.margin * portion) / p.size;
  const sm = (p.short.margin * portion) / p.size;
  let pl = pnlTokens(LONG, portion, p.entry, price); // short pnl = −pl
  if (pl > sm) pl = sm; // cap at what the loser actually locked
  if (pl < -lm) pl = -lm;
  let longOut = lm + pl;
  let shortOut = sm - pl;
  if (closer) {
    const fee = (portion * CLOSE_FEE_BPS) / BPS;
    if (closer === p.long.account) {
      const paid = fee < longOut ? fee : longOut;
      longOut -= paid;
      shortOut += paid;
    } else {
      const paid = fee < shortOut ? fee : shortOut;
      shortOut -= paid;
      longOut += paid;
    }
  }
  set(s.balances, p.long.account, get(s.balances, p.long.account) + longOut);
  set(s.balances, p.short.account, get(s.balances, p.short.account) + shortOut);
  p.size -= portion;
  p.long.margin -= lm;
  p.short.margin -= sm;
}

function belowMaint(p: FutPair, price: bigint): FutSide | null {
  const pl = pnlTokens(LONG, p.size, p.entry, price);
  const maint = (p.size * MAINT_BPS) / BPS;
  if (p.long.margin + pl <= maint) return LONG;
  if (p.short.margin - pl <= maint) return SHORT;
  return null;
}

/** Deterministic liquidation sweep: a pair is closed only when its losing side
 * is at/below maintenance at BOTH spot and twap, and settles at the price more
 * favourable to that loser. No-op without pairs. */
export function sweepFutures(s: State, f: FutState, now: number | undefined): void {
  if (f.pairs.length === 0) return;
  const spot = markPrice(s);
  if (spot <= 0n) return;
  const twap = twapPrice(s, f, now);
  const keep: FutPair[] = [];
  for (const p of f.pairs) {
    const a = belowMaint(p, spot);
    const b = belowMaint(p, twap);
    if (a != null && a === b) settlePortion(s, p, p.size, worseFor(a === LONG ? SHORT : LONG, true, spot, twap));
    else keep.push(p);
  }
  f.pairs = keep;
}

/** Open a position: lock `margin` tokens, match FIFO against the opposite
 * side at the taker-adverse price, rest the remainder. Mutates `s` and `f`. */
export function openFutures(
  s: State,
  f: FutState,
  sender: string,
  side: FutSide,
  size: bigint,
  margin: bigint,
  now: number | undefined
): void {
  if (size <= 0n) throw new InvalidOp("zero size");
  if (margin <= 0n) throw new InvalidOp("zero margin");
  if (size > margin * MAX_LEVERAGE) throw new InvalidOp("leverage too high");
  const spot = markPrice(s);
  if (spot <= 0n) throw new InvalidOp("no liquidity");
  const bal = get(s.balances, sender);
  if (bal < margin) throw new InvalidOp("insufficient balance");
  const capSupply = (s.supply * MAX_OI_BPS) / BPS;
  const capPool = (s.poolTokens * MAX_OI_POOL_BPS) / BPS;
  const cap = capSupply < capPool ? capSupply : capPool;
  if (sideOI(f, side) + size > cap) throw new InvalidOp("open interest cap");
  set(s.balances, sender, bal - margin);
  const wasActive = futuresActive(f);
  const entry = worseFor(side, false, spot, twapPrice(s, f, now));
  const origSize = size;
  let remSize = size;
  let remMargin = margin;
  const book: FutOrder[] = [];
  for (const o of f.book) {
    if (remSize <= 0n || o.side === side || o.account === sender) {
      book.push(o);
      continue;
    }
    const fill = remSize < o.size ? remSize : o.size;
    const makerM = (o.margin * fill) / o.size;
    const takerM = (margin * fill) / origSize;
    const taker = { account: sender, margin: takerM };
    const maker = { account: o.account, margin: makerM };
    f.pairs.push({
      id: f.nextId++,
      size: fill,
      entry,
      long: side === LONG ? taker : maker,
      short: side === SHORT ? taker : maker,
    });
    o.size -= fill;
    o.margin -= makerM;
    remSize -= fill;
    remMargin -= takerM;
    if (o.size > 0n) book.push(o);
    else if (o.margin > 0n) set(s.balances, o.account, get(s.balances, o.account) + o.margin); // rounding dust
  }
  f.book = book;
  if (remSize > 0n) f.book.push({ id: f.nextId++, account: sender, side, size: remSize, margin: remMargin });
  else if (remMargin > 0n) set(s.balances, sender, get(s.balances, sender) + remMargin);
  if (!wasActive) recordSample(s, f, now); // sampling begins with the first open
  sweepFutures(s, f, now);
}

/** Close up to `size` of the sender's positions FIFO (0 = cancel all resting
 * orders AND close every position). The counterparty of each closed portion is
 * settled at the same closer-adverse price; the closer pays CLOSE_FEE to them. */
export function closeFutures(s: State, f: FutState, sender: string, size: bigint, now: number | undefined): void {
  const spot = markPrice(s);
  if (spot <= 0n) throw new InvalidOp("no liquidity");
  const twap = twapPrice(s, f, now);
  let did = false;
  if (size === 0n) {
    const keep: FutOrder[] = [];
    for (const o of f.book) {
      if (o.account !== sender) {
        keep.push(o);
        continue;
      }
      set(s.balances, sender, get(s.balances, sender) + o.margin);
      did = true;
    }
    f.book = keep;
  }
  let rem = size === 0n ? -1n : size; // −1 = unlimited
  const keep: FutPair[] = [];
  for (const p of f.pairs) {
    const mine = p.long.account === sender || p.short.account === sender;
    if (!mine || rem === 0n) {
      keep.push(p);
      continue;
    }
    const mySide: FutSide = p.long.account === sender ? LONG : SHORT;
    const portion = rem < 0n || rem >= p.size ? p.size : rem;
    settlePortion(s, p, portion, worseFor(mySide, true, spot, twap), sender);
    did = true;
    if (rem > 0n) rem -= portion;
    if (p.size > 0n) keep.push(p);
  }
  f.pairs = keep;
  if (!did) throw new InvalidOp("nothing to close");
  sweepFutures(s, f, now);
}

/** Read-only view: an account's open exposure (for UI/API). */
export function positionsOf(f: FutState, account: string) {
  return {
    orders: f.book.filter((o) => o.account === account),
    pairs: f.pairs.filter((p) => p.long.account === account || p.short.account === account),
  };
}
