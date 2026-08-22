// HoldFun Nano L2 — deterministic token state machine.
//
// Pure functions: applyOps(state, blocks) -> state. No network, no timestamps,
// no keys. Two implementations replaying the same blocks MUST produce identical
// state — that is the entire trust model.

import type { Op } from "./ops";

export const PRECISION = 1_000_000_000_000n;
export const BPS = 10_000n;
export const MAX_CREATOR_SHARE_BPS = 500n; // 5%
export const TAX_BPS = 2_000n; // 20% exit tax
export const TAX_BURN_SHARE_BPS = 2_500n; // 25% of tax = 5% of amount
export const SWAP_FEE_BPS = 100n; // 1%

export class InvalidOp extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidOp";
  }
}

export interface State {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  launched: boolean;
  supply: bigint;
  creator: string;
  creatorShare: bigint;
  balances: Map<string, bigint>;
  staked: Map<string, bigint>;
  // Harvested-but-unclaimed rewards per staker (banked at each stake change).
  banked: Map<string, bigint>;
  // rewardDebt[a] = staked[a] * rewardPerShare / PRECISION at last settle.
  rewardDebt: Map<string, bigint>;
  totalStaked: bigint;
  // Accumulated XNO-rebate reward per staked unit (× PRECISION). Each rebate is
  // distributed pro-rata to the CURRENT stakers by stake, which is bounded and
  // independent of the (per-account, attacker-inflatable) block height.
  rewardPerShare: bigint;
  rebateVault: bigint;
  treasury: bigint;
  poolXno: bigint;
  poolTokens: bigint;
  // Exit-only settlement (viral-PoW design): a sell no longer entitles an
  // immediate on-chain payout. Its XNO proceeds accrue here as an in-game
  // credit — a pure replay quantity, zero blocks, zero PoW — and only an
  // explicit `withdraw` op moves credit into xnoWithdrawn, the CUMULATIVE
  // withdrawal total per account that the settlement layer pays against
  // (owed = withdrawn − chain-sent). Cumulative-vs-cumulative netting makes
  // era transitions safe by construction: pre-feature sells replay as credit,
  // and any XNO the pool already sent a recipient counts against their first
  // withdrawal, so nothing can ever be double-paid or clawed back.
  xnoCredit: Map<string, bigint>;
  xnoWithdrawn: Map<string, bigint>;
  // ── Direct-Settlement (zero-custody) mode ─────────────────────────────────
  // `direct` tokens have NO pool account and no operator key, ever. The AMM
  // reserves are VIRTUAL (replay-only numbers); real XNO only ever moves
  // wallet-to-wallet: a buy either pays a queued seller directly (validity-
  // bound to the chained send's destination) or stays in the buyer's own
  // account as `earmark` collateral. A sell settles instantly up to
  // min(quote, earmark, signed exit-block balance) by RELEASING the seller's
  // own earmark (no transfer needed — the XNO never left their account), and
  // only the remainder — exit-realized appreciation — is queued as a claim on
  // future buy flow, quoted at face × min(1, coverage).
  direct: boolean;
  // Remaining self-collateral at cost, per buyer. Invariant (policed by
  // `balance` observations + applyVoid): the account's real balance ≥ floor.
  earmark: Map<string, bigint>;
  // Ratcheted floor per earmark holder: only ever falls, tracking
  // min(earmark, current sell-value of their position). The guaranteed layer —
  // dropping the real balance below it voids the position proportionally.
  earmarkFloor: Map<string, bigint>;
  // FIFO flow-backed claims (sellers' unpaid appreciation). Paid directly by
  // future buys, wallet-to-wallet; the replay only does the bookkeeping.
  queue: { account: string; owed: bigint }[];
  // Buy-excess prepayments: when a buy pays a queued seller MORE than their
  // residual owed, the excess is real XNO the seller already received — it
  // nets against their future sell proceeds first (no double-pay).
  prepaid: Map<string, bigint>;
  height: bigint;
}

export function emptyState(): State {
  return {
    id: "",
    name: "",
    symbol: "",
    decimals: 6,
    image: "",
    launched: false,
    supply: 0n,
    creator: "",
    creatorShare: 0n,
    balances: new Map(),
    staked: new Map(),
    banked: new Map(),
    rewardDebt: new Map(),
    totalStaked: 0n,
    rewardPerShare: 0n,
    rebateVault: 0n,
    treasury: 0n,
    poolXno: 0n,
    poolTokens: 0n,
    xnoCredit: new Map(),
    xnoWithdrawn: new Map(),
    direct: false,
    earmark: new Map(),
    earmarkFloor: new Map(),
    queue: [],
    prepaid: new Map(),
    height: 0n,
  };
}

function get(m: Map<string, bigint>, k: string): bigint {
  return m.get(k) ?? 0n;
}
function set(m: Map<string, bigint>, k: string, v: bigint) {
  if (v === 0n) m.delete(k);
  else m.set(k, v);
}

// Harvest a staker's pending reward into `banked` and reset their debt to the
// current accumulator. Bounded: a staker can only ever bank their pro-rata
// share of the rebates distributed while they were staked. No time/height term,
// so it cannot be gamed by inflating an account's block height, and repeated
// calls without a new rebate bank nothing (pending == 0).
function settle(s: State, a: string) {
  const st = get(s.staked, a);
  const acc = (st * s.rewardPerShare) / PRECISION;
  const pending = acc - get(s.rewardDebt, a);
  if (pending > 0n) set(s.banked, a, get(s.banked, a) + pending);
  set(s.rewardDebt, a, acc);
}

// Read-only view of a staker's claimable XNO reward: already-banked plus the
// pending accrual since their last settle. Mirrors `settle`'s math without
// mutating, for surfacing "claim now" amounts in the UI/API.
export function claimableReward(s: State, a: string): bigint {
  const st = get(s.staked, a);
  const pending = (st * s.rewardPerShare) / PRECISION - get(s.rewardDebt, a);
  return get(s.banked, a) + (pending > 0n ? pending : 0n);
}

// Reset a staker's debt after their stake changed (so future pending starts at 0).
function resetDebt(s: State, a: string) {
  set(s.rewardDebt, a, (get(s.staked, a) * s.rewardPerShare) / PRECISION);
}

// Distribute a new rebate across the CURRENT stakers, pro-rata by stake.
function syncRewards(s: State, newRebate: bigint) {
  if (newRebate > 0n && s.totalStaked > 0n) {
    s.rewardPerShare += (newRebate * PRECISION) / s.totalStaked;
  }
}

// Constant-product quote (fee taken off the input, stays in the pool).
function constantProductOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  const afterFee = (amountIn * (BPS - SWAP_FEE_BPS)) / BPS;
  if (reserveIn + afterFee <= 0n) throw new InvalidOp("insufficient liquidity");
  return (afterFee * reserveOut) / (reserveIn + afterFee);
}

// ── Direct-Settlement helpers ───────────────────────────────────────────────

// Instant sell-value of an account's whole position (balance + staked) at the
// current virtual reserves — what the curve would pay if they exited now.
function sellValueOf(s: State, a: string): bigint {
  const pos = get(s.balances, a) + get(s.staked, a);
  if (pos <= 0n || s.poolXno <= 0n || s.poolTokens <= 0n) return 0n;
  return (pos * s.poolXno) / (s.poolTokens + pos);
}

// Ratchet every earmark holder's floor DOWN to min(floor, earmark, sell-value).
// Called after each price-changing op on a direct token. Released collateral
// (the gap between earmark and floor) returns to the holder's free control;
// the earmark itself (netting base at exit) is unchanged.
function ratchetFloors(s: State) {
  for (const [a, em] of s.earmark) {
    const sv = sellValueOf(s, a);
    const cur = s.earmarkFloor.get(a) ?? em;
    let f = cur < em ? cur : em;
    if (sv < f) f = sv;
    set(s.earmarkFloor, a, f);
  }
}

function queueTotal(s: State): bigint {
  let t = 0n;
  for (const e of s.queue) t += e.owed;
  return t;
}

// Coverage numerator for quoting a seller: everyone ELSE's guaranteed
// (floored) collateral. A snapshot for haircut pricing — never a payment source.
function floorTotalExcept(s: State, a: string): bigint {
  let t = 0n;
  for (const [acct, f] of s.earmarkFloor) if (acct !== a) t += f;
  return t;
}

/** Proportionally void an earmark holder's position down to `newFloor` after a
 * balance observation showed their real balance below the ratcheted floor
 * (collateral defection). Tokens (held + staked) return to the virtual pool,
 * their queued claims shrink, and the earmark/floor drop to what the chain
 * proves still exists. Pure — returns a fresh state. */
export function applyVoid(s0: State, account: string, newFloor: bigint): State {
  const floor = s0.earmarkFloor.get(account) ?? 0n;
  if (!s0.direct || floor <= 0n || newFloor >= floor) return s0;
  const s = cloneState(s0);
  const short = floor - (newFloor > 0n ? newFloor : 0n);
  const bal = get(s.balances, account);
  const vb = (bal * short) / floor;
  set(s.balances, account, bal - vb);
  let voided = vb;
  const st = get(s.staked, account);
  if (st > 0n) {
    settle(s, account); // bank pending rewards at the old stake first
    const vs = (st * short) / floor;
    set(s.staked, account, st - vs);
    s.totalStaked -= vs;
    resetDebt(s, account);
    voided += vs;
  }
  s.poolTokens += voided; // voided tokens back the remaining holders
  s.queue = s.queue
    .map((e) => (e.account === account ? { account: e.account, owed: e.owed - (e.owed * short) / floor } : e))
    .filter((e) => e.owed > 0n);
  const em = get(s.earmark, account);
  set(s.earmark, account, em - (em * short) / floor);
  set(s.earmarkFloor, account, newFloor > 0n ? newFloor : 0n);
  return s;
}

/** Sum of an account's ratcheted floors — the balance it must keep on-chain. */
export function requiredFloor(s: State, account: string): bigint {
  return s.earmarkFloor.get(account) ?? 0n;
}

function cloneState(s0: State): State {
  return {
    ...s0,
    balances: new Map(s0.balances),
    staked: new Map(s0.staked),
    banked: new Map(s0.banked),
    rewardDebt: new Map(s0.rewardDebt),
    xnoCredit: new Map(s0.xnoCredit),
    xnoWithdrawn: new Map(s0.xnoWithdrawn),
    earmark: new Map(s0.earmark),
    earmarkFloor: new Map(s0.earmarkFloor),
    queue: s0.queue.map((e) => ({ ...e })),
    prepaid: new Map(s0.prepaid),
  };
}

export function applyOp(s0: State, op: Op, sender: string, height: bigint): State {
  // Balance observations are handled at the multi-token layer (cross-token
  // floor proration) — reaching a single-token apply they are a pure no-op.
  if (op.kind === "balance") return s0;

  const s = cloneState(s0);

  switch (op.kind) {
    case "launch": {
      if (s.launched) throw new InvalidOp("already launched");
      if (op.supply <= 0n) throw new InvalidOp("zero supply");
      const creatorShare = (op.supply * MAX_CREATOR_SHARE_BPS) / BPS; // floor(5%)
      if (creatorShare <= 0n) throw new InvalidOp("supply too small");
      s.launched = true;
      s.direct = Boolean(op.direct);
      s.creator = sender;
      s.creatorShare = creatorShare;
      s.supply = op.supply;
      s.name = op.name;
      s.symbol = op.symbol;
      s.decimals = op.decimals;
      s.image = op.image;
      set(s.balances, sender, creatorShare);
      s.treasury = op.supply - creatorShare;
      s.height = height;
      return s;
    }

    case "transfer": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (op.amount <= 0n) throw new InvalidOp("zero amount");
      const bal = get(s.balances, sender);
      if (bal < op.amount) throw new InvalidOp("insufficient balance");
      set(s.balances, sender, bal - op.amount);
      set(s.balances, op.to, get(s.balances, op.to) + op.amount);
      s.height = height;
      return s;
    }

    case "buy": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (op.xno <= 0n) throw new InvalidOp("zero xno");
      if (s.poolXno <= 0n || s.poolTokens <= 0n) throw new InvalidOp("no liquidity");
      if (!s.direct) {
        const out = constantProductOut(s.poolXno, s.poolTokens, op.xno);
        if (out < op.minTokens || out >= s.poolTokens) throw new InvalidOp("slippage");
        s.poolXno += op.xno;
        s.poolTokens -= out;
        set(s.balances, sender, get(s.balances, sender) + out);
        s.height = height;
        return s;
      }
      // Direct-Settlement buy. Two lanes:
      //  (a) queue-routed: the chained deposit paid a QUEUED seller directly
      //      (depositTo, indexer-attached from the send's destination). Tokens
      //      mint through the curve on min(xno, that seller's residual owed);
      //      any excess is a prepayment netting against the seller's future
      //      proceeds — never a second mint (no double-count).
      //  (b) self-earmark (queue empty only): no deposit — the declared xno
      //      stays in the buyer's own account as collateral, validity-checked
      //      against the SIGNED carrier-block balance.
      if (op.depositTo) {
        const entry = s.queue.find((e) => e.account === op.depositTo && e.owed > 0n);
        if (!entry) throw new InvalidOp("deposit does not pay a queued seller");
        const pay = op.xno < entry.owed ? op.xno : entry.owed;
        entry.owed -= pay;
        const excess = op.xno - pay;
        if (excess > 0n) set(s.prepaid, op.depositTo, get(s.prepaid, op.depositTo) + excess);
        s.queue = s.queue.filter((e) => e.owed > 0n);
        const out = constantProductOut(s.poolXno, s.poolTokens, pay);
        if (out < op.minTokens || out >= s.poolTokens) throw new InvalidOp("slippage");
        s.poolXno += pay;
        s.poolTokens -= out;
        set(s.balances, sender, get(s.balances, sender) + out);
      } else {
        if (s.queue.some((e) => e.owed > 0n)) throw new InvalidOp("queued sellers must be paid first");
        // The earmark commits xno ON TOP of any floor already required — the
        // signed block balance must cover both, or the buy is invalid.
        const bal = op.balanceAt ?? 0n;
        if (bal < op.xno + (s.earmarkFloor.get(sender) ?? 0n)) throw new InvalidOp("insufficient collateral");
        const out = constantProductOut(s.poolXno, s.poolTokens, op.xno);
        if (out < op.minTokens || out >= s.poolTokens) throw new InvalidOp("slippage");
        s.poolXno += op.xno;
        s.poolTokens -= out;
        set(s.balances, sender, get(s.balances, sender) + out);
        set(s.earmark, sender, get(s.earmark, sender) + op.xno);
        set(s.earmarkFloor, sender, (s.earmarkFloor.get(sender) ?? 0n) + op.xno);
      }
      ratchetFloors(s);
      s.height = height;
      return s;
    }

    case "sell": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (op.tokens <= 0n) throw new InvalidOp("zero tokens");
      const bal = get(s.balances, sender);
      if (bal < op.tokens) throw new InvalidOp("insufficient balance");
      if (s.poolXno <= 0n || s.poolTokens <= 0n) throw new InvalidOp("no liquidity");
      const out = (op.tokens * s.poolXno) / (s.poolTokens + op.tokens);
      if (out < op.minXno || out >= s.poolXno) throw new InvalidOp("slippage");
      set(s.balances, sender, bal - op.tokens);
      s.poolTokens += op.tokens;
      s.poolXno -= out;
      if (!s.direct) {
        // Proceeds become in-game credit (see State.xnoCredit) — the real XNO
        // stays in the pool account until the seller explicitly withdraws.
        set(s.xnoCredit, sender, get(s.xnoCredit, sender) + out);
        s.height = height;
        return s;
      }
      // Direct-Settlement sell: three-layer netting (the verified accounting
      // identity — the flow-backed queue must equal exactly unpaid
      // exit-realized appreciation, never phantom claims):
      //  1. prepaid — XNO a buy already overpaid them (received early);
      //  2. self-net — min(remainder, earmark, SIGNED exit-block balance):
      //     settled instantly by releasing their OWN collateral, zero
      //     counterparty. The actual-balance cap means a defector who
      //     stripped collateral cannot self-net what the chain proves gone;
      //  3. flow queue — the rest (appreciation), quoted at face × min(1, R)
      //     where R = everyone else's floored collateral / total claims.
      //     The haircut's shaved part returns to the virtual pool.
      const pre = get(s.prepaid, sender);
      const usePre = out < pre ? out : pre;
      set(s.prepaid, sender, pre - usePre);
      let rem = out - usePre;
      const em = get(s.earmark, sender);
      const exitBal = op.balanceAt ?? 0n;
      let net = rem < em ? rem : em;
      if (net > exitBal) net = exitBal;
      set(s.earmark, sender, em - net);
      // Re-clamp their floor to the reduced earmark (release is instant).
      const fl = s.earmarkFloor.get(sender) ?? 0n;
      const emAfter = em - net;
      if (fl > emAfter) set(s.earmarkFloor, sender, emAfter);
      rem -= net;
      let credited = 0n;
      if (rem > 0n) {
        const num = floorTotalExcept(s, sender);
        const den = queueTotal(s) + rem;
        credited = num >= den ? rem : (rem * num) / den;
        if (credited > 0n) s.queue = [...s.queue, { account: sender, owed: credited }];
        s.poolXno += rem - credited; // the shaved part backs the remaining holders
      }
      // The slippage guard covers the seller's ECONOMIC total: prepayment
      // netted + own collateral released + queued (post-haircut) claim.
      if (usePre + net + credited < op.minXno) throw new InvalidOp("slippage");
      ratchetFloors(s);
      s.height = height;
      return s;
    }

    case "withdraw": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (s.direct) throw new InvalidOp("direct tokens settle at sell");
      const credit = get(s.xnoCredit, sender);
      if (credit <= 0n) throw new InvalidOp("nothing to withdraw");
      set(s.xnoWithdrawn, sender, get(s.xnoWithdrawn, sender) + credit);
      set(s.xnoCredit, sender, 0n);
      s.height = height;
      return s;
    }

    case "stake": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (op.amount <= 0n) throw new InvalidOp("zero amount");
      const bal = get(s.balances, sender);
      if (bal < op.amount) throw new InvalidOp("insufficient balance");
      settle(s, sender); // harvest pending at the old stake first
      set(s.balances, sender, bal - op.amount);
      set(s.staked, sender, get(s.staked, sender) + op.amount);
      s.totalStaked += op.amount;
      resetDebt(s, sender);
      s.height = height;
      return s;
    }

    case "unstake": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (op.amount <= 0n) throw new InvalidOp("zero amount");
      const st = get(s.staked, sender);
      if (st < op.amount) throw new InvalidOp("insufficient stake");
      settle(s, sender); // harvest pending at the old stake first
      const tax = (op.amount * TAX_BPS) / BPS;
      const burn = (tax * TAX_BURN_SHARE_BPS) / BPS;
      const rebate = tax - burn;
      const toUser = op.amount - tax;
      s.supply -= burn; // permanent deflation
      s.rebateVault += rebate;
      // Reduce the unstaker's stake BEFORE distributing their own rebate, so the
      // rebate goes to the REMAINING stakers (the reward for holding).
      set(s.balances, sender, get(s.balances, sender) + toUser);
      set(s.staked, sender, st - op.amount);
      s.totalStaked -= op.amount;
      resetDebt(s, sender);
      syncRewards(s, rebate);
      s.height = height;
      return s;
    }

    case "claim": {
      if (!s.launched) throw new InvalidOp("not launched");
      settle(s, sender); // bank any pending into `banked`
      const owed = get(s.banked, sender);
      if (owed <= 0n) throw new InvalidOp("nothing to claim");
      const payout = owed < s.rebateVault ? owed : s.rebateVault;
      if (payout <= 0n) throw new InvalidOp("nothing to claim");
      set(s.banked, sender, owed - payout);
      s.rebateVault -= payout;
      set(s.balances, sender, get(s.balances, sender) + payout);
      s.height = height;
      return s;
    }

    case "seedLiq":
    case "addLiq": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (sender !== s.creator) throw new InvalidOp("creator only");
      // Reject negatives on EITHER leg — a negative `tokens` with a positive
      // `xno` must never slip through (it would push poolTokens negative / move
      // pool tokens back to treasury and corrupt the AMM).
      if (op.xno < 0n || op.tokens < 0n) throw new InvalidOp("negative amount");
      if (op.xno <= 0n && op.tokens <= 0n) throw new InvalidOp("zero amounts");
      if (op.tokens > s.treasury) throw new InvalidOp("exceeds treasury");
      s.treasury -= op.tokens;
      // Direct tokens: xno is a DECLARED VIRTUAL reserve (frag-encoded, no
      // deposit, no pool account) — it only sets the price curve. It claims no
      // real money: the first sellers' quotes against it queue as flow-backed
      // claims until real buys arrive, so an inflated virtual seed only hurts
      // the creator's own exit (their sell has no earmark and queues at R=0
      // until real buyers commit collateral).
      s.poolXno += op.xno;
      s.poolTokens += op.tokens;
      if (s.direct) ratchetFloors(s);
      s.height = height;
      return s;
    }

    default:
      throw new InvalidOp("unknown op");
  }
}

export function applyOps(initial: State, blocks: { op: Op; sender: string; height: bigint }[]): State {
  let s = initial;
  for (const b of blocks) s = applyOp(s, b.op, b.sender, b.height);
  return s;
}
