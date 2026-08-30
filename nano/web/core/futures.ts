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
//   mark   = poolXno × PRECISION / poolTokens            (XNO-raw per token, ×1e12)
//   long   pnl(tokens) = size × (mark − entry) / mark
//   short  pnl(tokens) = size × (entry − mark) / mark
//   |loss| is capped at the loser's margin (bankruptcy price) — a winner can
//   never be owed more than the counterparty actually locked, so the system is
//   solvent by construction with no insurance fund.
// Positions are strictly PAIRED: an open matches FIFO against resting
// opposite-side orders (partial fills allowed); the rest waits in the book.
// Closing one side closes the pair symmetrically (the counterparty is settled
// at the same mark) — the closer pays CLOSE_FEE to the party it closed.
// Liquidation is deterministic: after every price-changing op, any pair whose
// losing side's equity ≤ maintenance is closed at mark (no fee).
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
  entry: bigint; // mark at match (× PRECISION)
  long: { account: string; margin: bigint };
  short: { account: string; margin: bigint };
}

export interface FutState {
  book: FutOrder[]; // resting orders, FIFO per side
  pairs: FutPair[]; // open matched positions, ascending id
  nextId: bigint;
}

export function emptyFutures(): FutState {
  return { book: [], pairs: [], nextId: 0n };
}

export function cloneFutures(f: FutState): FutState {
  return {
    book: f.book.map((o) => ({ ...o })),
    pairs: f.pairs.map((p) => ({ ...p, long: { ...p.long }, short: { ...p.short } })),
    nextId: f.nextId,
  };
}

/** Has this token ever had futures activity? (Controls canonical inclusion.) */
export function futuresActive(f: FutState): boolean {
  return f.nextId > 0n || f.book.length > 0 || f.pairs.length > 0;
}

/** Spot mark from the virtual reserves (× PRECISION). 0 when unpriced. */
export function markPrice(s: State): bigint {
  if (s.poolXno <= 0n || s.poolTokens <= 0n) return 0n;
  return (s.poolXno * PRECISION) / s.poolTokens;
}

/** Signed pnl in tokens for `side` on `size` from `entry` to `mark`. */
export function pnlTokens(side: FutSide, size: bigint, entry: bigint, mark: bigint): bigint {
  if (mark <= 0n) return 0n;
  const diff = side === LONG ? mark - entry : entry - mark;
  return (size * diff) / mark; // floor toward −∞ for negatives is fine: symmetric use below
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

/** Settle one pair (or a `portion` of it) at `mark`, returning tokens to both
 * parties' balances. `closer` (if given) pays CLOSE_FEE on the portion to the
 * other side. Loss is capped at the loser's prorated margin. Mutates `s`. */
function settlePortion(s: State, f: FutState, p: FutPair, portion: bigint, mark: bigint, closer?: string) {
  const lm = (p.long.margin * portion) / p.size;
  const sm = (p.short.margin * portion) / p.size;
  let pl = pnlTokens(LONG, portion, p.entry, mark); // short pnl = −pl
  // Cap at what the loser actually locked.
  if (pl > sm) pl = sm;
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

/** Deterministic liquidation sweep: close every pair whose losing side's
 * equity ≤ maintenance at the current mark. No-op without pairs. */
export function sweepFutures(s: State, f: FutState): void {
  if (f.pairs.length === 0) return;
  const mark = markPrice(s);
  if (mark <= 0n) return;
  const keep: FutPair[] = [];
  for (const p of f.pairs) {
    const pl = pnlTokens(LONG, p.size, p.entry, mark);
    const maint = (p.size * MAINT_BPS) / BPS;
    const longEq = p.long.margin + pl;
    const shortEq = p.short.margin - pl;
    if (longEq <= maint || shortEq <= maint) settlePortion(s, f, p, p.size, mark);
    else keep.push(p);
  }
  f.pairs = keep;
}

/** Open a position: lock `margin` tokens, match FIFO against the opposite
 * side, rest the remainder. Mutates `s` and `f`. */
export function openFutures(s: State, f: FutState, sender: string, side: FutSide, size: bigint, margin: bigint): void {
  if (size <= 0n) throw new InvalidOp("zero size");
  if (margin <= 0n) throw new InvalidOp("zero margin");
  if (size > margin * MAX_LEVERAGE) throw new InvalidOp("leverage too high");
  const mark = markPrice(s);
  if (mark <= 0n) throw new InvalidOp("no liquidity");
  const bal = get(s.balances, sender);
  if (bal < margin) throw new InvalidOp("insufficient balance");
  if (sideOI(f, side) + size > (s.supply * MAX_OI_BPS) / BPS) throw new InvalidOp("open interest cap");
  set(s.balances, sender, bal - margin);
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
    const legs = { taker: { account: sender, margin: takerM }, maker: { account: o.account, margin: makerM } };
    f.pairs.push({
      id: f.nextId++,
      size: fill,
      entry: mark,
      long: side === LONG ? legs.taker : legs.maker,
      short: side === SHORT ? legs.taker : legs.maker,
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
  sweepFutures(s, f);
}

/** Close up to `size` of the sender's positions FIFO (0 = cancel all resting
 * orders AND close every position). The counterparty of each closed portion is
 * settled at the same mark; the closer pays CLOSE_FEE to them. */
export function closeFutures(s: State, f: FutState, sender: string, size: bigint): void {
  const mark = markPrice(s);
  if (mark <= 0n) throw new InvalidOp("no liquidity");
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
    const portion = rem < 0n || rem >= p.size ? p.size : rem;
    settlePortion(s, f, p, portion, mark, sender);
    did = true;
    if (rem > 0n) rem -= portion;
    if (p.size > 0n) keep.push(p);
  }
  f.pairs = keep;
  if (!did) throw new InvalidOp("nothing to close");
  sweepFutures(s, f);
}

/** Read-only view: an account's open exposure (for UI/API). */
export function positionsOf(f: FutState, account: string) {
  return {
    orders: f.book.filter((o) => o.account === account),
    pairs: f.pairs.filter((p) => p.long.account === account || p.short.account === account),
  };
}
