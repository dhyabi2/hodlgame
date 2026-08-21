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

export function applyOp(s0: State, op: Op, sender: string, height: bigint): State {
  const s: State = {
    ...s0,
    balances: new Map(s0.balances),
    staked: new Map(s0.staked),
    banked: new Map(s0.banked),
    rewardDebt: new Map(s0.rewardDebt),
  };

  switch (op.kind) {
    case "launch": {
      if (s.launched) throw new InvalidOp("already launched");
      if (op.supply <= 0n) throw new InvalidOp("zero supply");
      const creatorShare = (op.supply * MAX_CREATOR_SHARE_BPS) / BPS; // floor(5%)
      if (creatorShare <= 0n) throw new InvalidOp("supply too small");
      s.launched = true;
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
      const out = constantProductOut(s.poolXno, s.poolTokens, op.xno);
      if (out < op.minTokens || out >= s.poolTokens) throw new InvalidOp("slippage");
      s.poolXno += op.xno;
      s.poolTokens -= out;
      set(s.balances, sender, get(s.balances, sender) + out);
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
      s.poolXno += op.xno;
      s.poolTokens += op.tokens;
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
