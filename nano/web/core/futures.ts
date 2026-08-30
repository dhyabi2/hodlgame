// HodlGame Futures — token-margined (inverse) perpetual positions.
//
// WHY THIS IS THE ONLY TRUSTLESS DERIVATIVE ON NANO: the chain cannot seize
// XNO from anyone, but a HodlGame token exists ONLY as replay state. Margin
// posted in the token is therefore enforceable by consensus — a loss is a
// balance move inside `State`, no escrow, no operator key, no oracle. Every
// payoff is a pure function of chain history that anyone re-derives
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
// MANIPULATION RESISTANCE — and why it uses NO CLOCK.
// Spot alone can be pumped inside one op for ~2% of swap fees, so pricing
// needs a lagging reference. A time-weighted average is the textbook answer
// and it is WRONG HERE: a Nano block's timestamp is `local_timestamp`, the
// moment the answering node first saw it. It is not covered by the signature
// and differs between nodes. Ordering already tolerates that because sorting
// is a DISCRETE function of timestamps (a one-second difference almost never
// swaps two blocks), but a time-weighted average is a CONTINUOUS one: any
// one-second difference changes the number, hence entry prices, hence
// balances, hence the state root. The server and the in-browser verifier would
// disagree — which would break the one guarantee the whole system sells.
//
// So the reference is anchored to VOLUME, which is consensus state:
//
//   mark ← mark + (spot − mark) × min(1, |Δ poolXno| / max(poolXno_before, poolXno_after))
//
// an exponential average in volume-time. Moving `mark` to a chosen price
// requires pushing a comparable fraction of the pool's own liquidity through
// the constant-product curve — paying the 1% swap fee and the slippage, both
// ways, while every other holder can trade against you. One giant buy no
// longer moves the reference much; sustained real volume does. It costs ONE
// bigint of state, is a pure function of the ordered block list, and contains
// no clock at all.
//
// Pricing rules built on it (`lo = min(spot, mark)`, `hi = max(spot, mark)`):
//   entry  — the TAKER gets the worse side (long `hi`, short `lo`);
//   close  — the pair settles at the price worse for the CLOSER;
//   liquidation — fires only when the loser is below maintenance at BOTH spot
//   and mark, and settles at the price more favourable to that loser.
//
// Positions are strictly PAIRED: an open matches FIFO against resting
// opposite-side orders (partial fills allowed); the rest waits in the book.
// Closing one side closes the pair symmetrically (the counterparty is settled
// at the same price) — the closer pays CLOSE_FEE to the party it closed.
//
// Era-gated: futures ops stamped before FUTURES_ERA are invalid, and every
// hook is a no-op while a token has no futures activity — so replay of all
// pre-existing history is byte-identical (verified against the live
// production ledger).

import { BPS, PRECISION, InvalidOp, type State } from "./state";

/** Era boundary (unix seconds, 2026-08-30 14:26:40 UTC). Futures ops stamped
 * before this — or unstamped, or not a finite number — are invalid. */
export const FUTURES_ERA = 1_788_100_000;
export const MAX_LEVERAGE = 5n; // size ≤ margin × 5
export const MAINT_BPS = 500n; // liquidate when equity ≤ 5% of size
export const CLOSE_FEE_BPS = 50n; // 0.5% of closed size, closer → counterparty
export const MAX_OI_BPS = 2_500n; // each side's open interest ≤ 25% of supply
// … and ≤ 10% of the token reserve (depth-aware). This is the cap that bounds
// what a price manipulator can WIN: the prize is the counterparty margin they
// can liquidate, so keeping open interest small relative to the pool keeps it
// below the cost of pushing that much volume through the curve.
export const MAX_OI_POOL_BPS = 1_000n;
/** Reference responsiveness: `alpha = min(1, K × moved / pool)`. K = 4 means a
 * single trade worth a quarter of the pool fully repositions the reference,
 * and cumulative volume V closes `1 − e^(−4V/pool)` of any gap. Lower K is
 * harder to manipulate but strands winners on quiet tokens; this is the
 * balance point. */
export const MARK_RESPONSIVENESS = 4n;
// ── Anti-spam bounds. Nano is FEELESS: the only cost of a block is local PoW,
// so anything that grows replayed state per block MUST be capped by COUNT, not
// only by value. Without these, dust orders/pairs bloat the canonical state
// forever and make every later op O(book) to clone.
export const MAX_BOOK_SIDE = 32; // resting orders per side, per token
export const MAX_ORDERS_PER_ACCOUNT = 2; // resting orders one account may hold
export const MAX_PAIRS = 128; // open matched pairs per token
/** Minimum position size: supply/MIN_SIZE_DIV, never below BPS/MAINT_BPS (=20)
 * — under which `maint = size·MAINT_BPS/BPS` floors to 0 and `pnl` floors to 0,
 * making the pair mathematically un-liquidatable, i.e. immortal state. */
export const MIN_SIZE_DIV = 10_000n;
export const MAX_SETTLED = 32; // bounded receipt tape in state (oldest dropped)

export type FutSide = 0 | 1; // 0 = long, 1 = short
export const LONG: FutSide = 0;
export const SHORT: FutSide = 1;

export interface FutOrder {
  id: bigint;
  account: string;
  side: FutSide;
  size: bigint; // remaining unmatched size (tokens notional)
  margin: bigint; // tokens locked for the remaining size
  guard: bigint; // this signer's entry-price bound, honoured on later fills (0 = none)
}

export interface FutPair {
  id: bigint;
  size: bigint;
  entry: bigint; // price at match (× PRECISION)
  long: { account: string; margin: bigint };
  short: { account: string; margin: bigint };
}

/** A settled portion of a pair — the verifiable "duel receipt". `longPnl` is
 * the tokens that moved from short to long (negative = the other way), fee
 * included; `kind` 1 = liquidation (no closer), 0 = voluntary close. `seq` is
 * a per-token monotone counter that makes every receipt unique, so a derived
 * tape can never confuse two identical settlements. */
export interface FutSettled {
  seq: bigint;
  id: bigint; // pair id
  size: bigint;
  entry: bigint;
  price: bigint; // settlement price (× PRECISION)
  long: string;
  short: string;
  longPnl: bigint;
  kind: 0 | 1;
  closer: string; // "" for liquidations
}

export interface FutState {
  book: FutOrder[]; // resting orders, FIFO per side
  pairs: FutPair[]; // open matched positions, ascending id
  nextId: bigint;
  /** Volume-anchored reference price (× PRECISION). 0 until the token's first
   * futOpen, where it is seeded from spot. No clock, ever. */
  mark: bigint;
  settled: FutSettled[]; // recent settlements, oldest first
  nextSeq: bigint;
}

export function emptyFutures(): FutState {
  return { book: [], pairs: [], nextId: 0n, mark: 0n, settled: [], nextSeq: 0n };
}

export function cloneFutures(f: FutState): FutState {
  return {
    book: f.book.map((o) => ({ ...o })),
    pairs: f.pairs.map((p) => ({ ...p, long: { ...p.long }, short: { ...p.short } })),
    nextId: f.nextId,
    mark: f.mark,
    settled: f.settled.map((x) => ({ ...x })),
    nextSeq: f.nextSeq,
  };
}

/** Has this token ever had futures activity? Controls canonical inclusion and
 * every hook, so pre-futures history is untouched. Monotone: never goes back
 * to false once a position has been opened. */
export function futuresActive(f: FutState): boolean {
  return f.nextId > 0n || f.book.length > 0 || f.pairs.length > 0 || f.mark > 0n;
}

/** Spot from the virtual reserves (× PRECISION). 0 when unpriced. */
export function markPrice(s: State): bigint {
  if (s.poolXno <= 0n || s.poolTokens <= 0n) return 0n;
  return (s.poolXno * PRECISION) / s.poolTokens;
}

/** The lagging reference. Falls back to spot before the token is active. */
export function refPrice(s: State, f: FutState): bigint {
  return f.mark > 0n ? f.mark : markPrice(s);
}

/**
 * Advance the volume-anchored mark after a price-moving op. `prevPoolXno` is
 * the XNO reserve before the op; the weight is the fraction of the pool that
 * moved, so the reference only travels as far as real volume carries it.
 * A no-op for tokens with no futures activity — this is what keeps every
 * pre-futures replay byte-identical.
 */
export function updateMark(s: State, f: FutState, prevPoolXno: bigint, prevPoolTokens: bigint): void {
  if (!futuresActive(f)) return;
  const spot = markPrice(s);
  if (spot <= 0n) return;
  if (f.mark <= 0n) {
    f.mark = spot;
    return;
  }
  // Weight by the LARGER relative move of the two reserves. Weighting on XNO
  // alone would miss `addLiq(xno = 0, tokens = …)`, which is creator-only, free
  // and repositions spot arbitrarily while moving no XNO at all — leaving a
  // stale reference that a resting maker could harvest a taker against.
  const fracX = relMove(prevPoolXno, s.poolXno);
  const fracT = relMove(prevPoolTokens, s.poolTokens);
  const num = fracX.num * fracT.den > fracT.num * fracX.den ? fracX : fracT;
  if (num.num <= 0n || num.den <= 0n) return;
  const gap = spot - f.mark;
  // mark += gap × min(1, K·moved/denom), in bigint, truncating toward zero.
  const w = num.num * MARK_RESPONSIVENESS;
  f.mark = w >= num.den ? spot : f.mark + (gap * w) / num.den;
}

/** |after − before| / max(before, after), as an exact fraction. */
function relMove(before: bigint, after: bigint): { num: bigint; den: bigint } {
  const num = after > before ? after - before : before - after;
  const den = after > before ? after : before;
  return { num, den };
}

/** Tokens this account has locked as futures margin (resting orders + pairs).
 * They are still the account's position — Direct-Settlement floor maths must
 * count them, or margin becomes a place to hide a position from the ratchet. */
export function lockedMarginOf(f: FutState, account: string): bigint {
  let t = 0n;
  for (const o of f.book) if (o.account === account) t += o.margin;
  for (const p of f.pairs) {
    if (p.long.account === account) t += p.long.margin;
    if (p.short.account === account) t += p.short.margin;
  }
  return t;
}

/** Void `short/floor` of an account's futures margin after collateral
 * defection, mirroring what `applyVoid` does to balances and stake. Returns
 * the tokens removed, which the caller hands back to the virtual reserves. */
export function voidMarginOf(f: FutState, account: string, short: bigint, floor: bigint): bigint {
  if (floor <= 0n || short <= 0n) return 0n;
  let voided = 0n;
  const keep: FutOrder[] = [];
  for (const o of f.book) {
    if (o.account !== account) {
      keep.push(o);
      continue;
    }
    const v = (o.margin * short) / floor;
    o.margin -= v;
    voided += v;
    if (o.margin > 0n) keep.push(o); // an order with nothing behind it is dropped
  }
  f.book = keep;
  for (const p of f.pairs) {
    if (p.long.account === account) {
      const v = (p.long.margin * short) / floor;
      p.long.margin -= v;
      voided += v;
    }
    if (p.short.account === account) {
      const v = (p.short.margin * short) / floor;
      p.short.margin -= v;
      voided += v;
    }
  }
  return voided;
}

/** Price that is WORSE for `side`. `forExit`: true when the side is closing. */
function worseFor(side: FutSide, forExit: boolean, spot: bigint, mark: bigint): bigint {
  const lo = spot < mark ? spot : mark;
  const hi = spot < mark ? mark : spot;
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

/** Does `entry` satisfy the signer's price bound? long: entry ≤ guard; short:
 * entry ≥ guard; 0 = unguarded. This is what keeps a fixpoint-DEFERRED open
 * inside the bounds its signer already accepted (SPEC §9). */
function guardOk(side: FutSide, entry: bigint, guard: bigint): boolean {
  if (guard <= 0n) return true;
  return side === LONG ? entry <= guard : entry >= guard;
}

/** The smallest position this token allows. Below it, `maint` and `pnl` both
 * floor to zero — a pair that can never be liquidated and never leaves state,
 * and a close that pays neither loss nor fee. Enforced on EVERY size that can
 * become a position: the incoming order, each fill, each resting residue, and
 * each closed portion. */
export function minPositionSize(s: State): bigint {
  const floorSize = BPS / MAINT_BPS;
  const bySupply = s.supply / MIN_SIZE_DIV;
  return bySupply > floorSize ? bySupply : floorSize;
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

/** Room for one more resting order: per-side depth and per-account count. */
function hasRoomToRest(f: FutState, account: string, side: FutSide): boolean {
  let sideCount = 0;
  let mine = 0;
  for (const o of f.book) {
    if (o.side === side) sideCount++;
    if (o.account === account) mine++;
  }
  return sideCount < MAX_BOOK_SIDE && mine < MAX_ORDERS_PER_ACCOUNT;
}

/** Settle one pair (or a `portion` of it) at `price`, returning tokens to both
 * parties' balances. `closer` (if given) pays CLOSE_FEE on the portion to the
 * other side. Loss is capped at the loser's prorated margin. Mutates `s`. */
function settlePortion(s: State, f: FutState, p: FutPair, portion: bigint, price: bigint, closer?: string) {
  if (p.size <= 0n) throw new InvalidOp("empty pair"); // unreachable; fail loudly, never divide by zero
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
  f.settled.push({
    seq: f.nextSeq++,
    id: p.id,
    size: portion,
    entry: p.entry,
    price,
    long: p.long.account,
    short: p.short.account,
    longPnl: longOut - lm,
    kind: closer ? 0 : 1,
    closer: closer ?? "",
  });
  while (f.settled.length > MAX_SETTLED) f.settled.shift();
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
 * is at/below maintenance at BOTH spot and mark, and settles at the price more
 * favourable to that loser. No-op without pairs. */
export function sweepFutures(s: State, f: FutState): void {
  if (f.pairs.length === 0) return;
  const spot = markPrice(s);
  if (spot <= 0n) return;
  const mark = refPrice(s, f);
  const keep: FutPair[] = [];
  for (const p of f.pairs) {
    const a = belowMaint(p, spot);
    const b = belowMaint(p, mark);
    if (a != null && a === b) settlePortion(s, f, p, p.size, worseFor(a === LONG ? SHORT : LONG, true, spot, mark));
    else keep.push(p);
  }
  f.pairs = keep;
}

/** Open a position: lock `margin` tokens, match FIFO against the opposite side
 * at the taker-adverse price, rest the remainder. Mutates `s` and `f`. */
export function openFutures(
  s: State,
  f: FutState,
  sender: string,
  side: FutSide,
  size: bigint,
  margin: bigint,
  guard: bigint
): void {
  if (size <= 0n) throw new InvalidOp("zero size");
  if (margin <= 0n) throw new InvalidOp("zero margin");
  // A price bound is MANDATORY. One large swap always dislocates spot further
  // than the reference, and `worseFor` hands that whole gap to the resting
  // side — so an unguarded taker is harvestable by a maker who moved the price
  // on purpose. Requiring a bound makes the dangerous default impossible.
  if (guard <= 0n) throw new InvalidOp("entry price guard required");
  if (size > margin * MAX_LEVERAGE) throw new InvalidOp("leverage too high");
  const minSize = minPositionSize(s);
  if (size < minSize) throw new InvalidOp("position too small");
  const spot = markPrice(s);
  if (spot <= 0n) throw new InvalidOp("no liquidity");
  const bal = get(s.balances, sender);
  if (bal < margin) throw new InvalidOp("insufficient balance");
  const capSupply = (s.supply * MAX_OI_BPS) / BPS;
  const capPool = (s.poolTokens * MAX_OI_POOL_BPS) / BPS;
  const cap = capSupply < capPool ? capSupply : capPool;
  if (sideOI(f, side) + size > cap) throw new InvalidOp("open interest cap");
  // Seed the reference on the token's first futures op, then price off it.
  if (f.mark <= 0n) f.mark = spot;
  const entry = worseFor(side, false, spot, f.mark);
  // The signer's price bound, checked BEFORE anything moves, so an open that
  // becomes valid later at a price they never accepted stays invalid.
  if (!guardOk(side, entry, guard)) throw new InvalidOp("entry price guard");
  // Would this have to rest, and is there room? (Checked before locking.)
  const canMatch = f.book.some((o) => o.side !== side && o.account !== sender && guardOk(o.side, entry, o.guard));
  if (!canMatch && !hasRoomToRest(f, sender, side)) throw new InvalidOp("order book full");
  set(s.balances, sender, bal - margin);
  const origSize = size;
  let remSize = size;
  let remMargin = margin;
  const book: FutOrder[] = [];
  for (const o of f.book) {
    // Stop matching at the pair cap — the remainder rests or is refunded,
    // rather than growing the pair list without bound. Also stop once the
    // remainder is below minSize: a sub-minimum FILL would mint exactly the
    // un-liquidatable dust pair minSize exists to prevent.
    if (remSize < minSize || o.side === side || o.account === sender || f.pairs.length >= MAX_PAIRS) {
      book.push(o);
      continue;
    }
    // A resting order carries its own signer's guard: filling it at a price
    // that signer never accepted would violate their bound, so skip it.
    if (!guardOk(o.side, entry, o.guard)) {
      book.push(o);
      continue;
    }
    // Never whittle a maker's order down to a sub-minimum residue: a partial
    // fill that would leave them under minSize is skipped entirely, so every
    // resting order stays liquidatable-sized.
    if (remSize < o.size && o.size - remSize < minSize) {
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
  // Rest the remainder only if it is a viable order AND there is room; else
  // refund it (a partial fill), so the book can never exceed its caps.
  if (remSize >= minSize && hasRoomToRest(f, sender, side)) {
    f.book.push({ id: f.nextId++, account: sender, side, size: remSize, margin: remMargin, guard });
  } else if (remMargin > 0n) set(s.balances, sender, get(s.balances, sender) + remMargin);
  sweepFutures(s, f);
}

/** Close up to `size` of the sender's positions FIFO (0 = cancel all resting
 * orders AND close every position). The counterparty of each closed portion is
 * settled at the same closer-adverse price; the closer pays CLOSE_FEE to them.
 *
 * Closing nothing is a NO-OP, never invalid: an invalid op is DEFERRED by the
 * fixpoint and retried after every later apply, so a close broadcast before
 * its position existed would spring to life against a position the signer
 * opened afterwards, at a price they never quoted. */
export function closeFutures(s: State, f: FutState, sender: string, size: bigint): void {
  const spot = markPrice(s);
  if (spot <= 0n) return;
  const mark = refPrice(s, f);
  const minSize = minPositionSize(s);
  if (size === 0n) {
    const keep: FutOrder[] = [];
    for (const o of f.book) {
      if (o.account !== sender) {
        keep.push(o);
        continue;
      }
      set(s.balances, sender, get(s.balances, sender) + o.margin);
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
    let portion = rem < 0n || rem >= p.size ? p.size : rem;
    // Dust-chunking defence. `pnl`, the prorated margins and the close fee all
    // floor: closing a pair in tiny slices rounds every one of them to zero,
    // which would let a loser walk away paying neither the loss nor the fee.
    // So a partial close must both TAKE at least minSize and LEAVE at least
    // minSize behind; anything else closes the whole pair.
    if (portion < minSize || p.size - portion < minSize) portion = p.size;
    settlePortion(s, f, p, portion, worseFor(mySide, true, spot, mark), sender);
    if (rem > 0n) rem -= portion;
    if (p.size > 0n) keep.push(p);
  }
  f.pairs = keep;
  sweepFutures(s, f);
}

/** Read-only view: an account's open exposure (for UI/API). */
export function positionsOf(f: FutState, account: string) {
  return {
    orders: f.book.filter((o) => o.account === account),
    pairs: f.pairs.filter((p) => p.long.account === account || p.short.account === account),
  };
}
