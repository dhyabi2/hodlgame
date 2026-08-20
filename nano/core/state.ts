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
  points: Map<string, bigint>;
  rewardDebt: Map<string, bigint>;
  lastHeight: Map<string, bigint>;
  totalStaked: bigint;
  totalPoints: bigint;
  rewardPerPoint: bigint;
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
    points: new Map(),
    rewardDebt: new Map(),
    lastHeight: new Map(),
    totalStaked: 0n,
    totalPoints: 0n,
    rewardPerPoint: 0n,
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

// Advance points using confirmation height as the clock.
function accrue(s: State, h: bigint) {
  if (h > s.height && s.totalStaked > 0n) {
    s.totalPoints += (h - s.height) * s.totalStaked;
  }
  s.height = h;
}

function settlePoints(s: State, a: string, h: bigint) {
  accrue(s, h);
  const st = get(s.staked, a);
  const start = get(s.lastHeight, a);
  if (h > start && st > 0n) {
    set(s.points, a, get(s.points, a) + (h - start) * st);
  }
  set(s.lastHeight, a, h);
  set(s.rewardDebt, a, (get(s.points, a) * s.rewardPerPoint) / PRECISION);
}

function syncRewards(s: State, newRebate: bigint) {
  if (newRebate > 0n && s.totalPoints > 0n) {
    s.rewardPerPoint += (newRebate * PRECISION) / s.totalPoints;
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
    points: new Map(s0.points),
    rewardDebt: new Map(s0.rewardDebt),
    lastHeight: new Map(s0.lastHeight),
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
      settlePoints(s, sender, height);
      set(s.balances, sender, bal - op.amount);
      set(s.staked, sender, get(s.staked, sender) + op.amount);
      s.totalStaked += op.amount;
      s.height = height;
      return s;
    }

    case "unstake": {
      if (!s.launched) throw new InvalidOp("not launched");
      const st = get(s.staked, sender);
      if (st < op.amount) throw new InvalidOp("insufficient stake");
      settlePoints(s, sender, height);
      const tax = (op.amount * TAX_BPS) / BPS;
      const burn = (tax * TAX_BURN_SHARE_BPS) / BPS;
      const rebate = tax - burn;
      const toUser = op.amount - tax;
      s.supply -= burn; // permanent deflation
      s.rebateVault += rebate;
      syncRewards(s, rebate);
      set(s.balances, sender, get(s.balances, sender) + toUser);
      set(s.staked, sender, st - op.amount);
      s.totalStaked -= op.amount;
      s.height = height;
      return s;
    }

    case "claim": {
      if (!s.launched) throw new InvalidOp("not launched");
      const debtBefore = get(s.rewardDebt, sender);
      settlePoints(s, sender, height);
      const full = (get(s.points, sender) * s.rewardPerPoint) / PRECISION;
      const pending = full - debtBefore;
      if (pending <= 0n) throw new InvalidOp("nothing to claim");
      const payout = pending < s.rebateVault ? pending : s.rebateVault;
      set(s.rewardDebt, sender, full - (pending - payout));
      s.rebateVault -= payout;
      set(s.balances, sender, get(s.balances, sender) + payout);
      s.height = height;
      return s;
    }

    case "seedLiq":
    case "addLiq": {
      if (!s.launched) throw new InvalidOp("not launched");
      if (sender !== s.creator) throw new InvalidOp("creator only");
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
