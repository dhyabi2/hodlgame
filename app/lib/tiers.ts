import { BN } from "@coral-xyz/anchor";

export interface Tier {
  name: string;
  emoji: string;
  color: string;
  glow: string;
  minSeconds: number;
}

export const TIERS: Tier[] = [
  { name: "Paper", emoji: "🧻", color: "text-slate-400", glow: "glow-danger", minSeconds: 0 },
  { name: "Bronze", emoji: "🥉", color: "text-amber-600", glow: "glow-jackpot", minSeconds: 60 * 60 * 24 },
  { name: "Silver", emoji: "🥈", color: "text-slate-300", glow: "glow-accent", minSeconds: 60 * 60 * 24 * 3 },
  { name: "Gold", emoji: "🥇", color: "text-holder-jackpot", glow: "glow-jackpot", minSeconds: 60 * 60 * 24 * 7 },
  { name: "Diamond", emoji: "💎", color: "text-holder-accent", glow: "glow-accent", minSeconds: 60 * 60 * 24 * 14 },
  { name: "Adamantium", emoji: "⚡", color: "text-holder-success", glow: "glow-accent", minSeconds: 60 * 60 * 24 * 30 },
];

export interface HoldingScore {
  tier: Tier;
  nextTier: Tier | null;
  avgHoldSeconds: number;
  avgHoldDays: number;
  progress: number; // 0..1 toward next tier
}

/**
 * points accumulates amount * seconds-held on every update, so points/amount
 * is the time-weighted average number of seconds each currently staked token
 * has been sitting there — the same quantity that drives rebate size.
 */
export function getHoldingScore(
  points: BN | string | number,
  amount: BN | string | number
): HoldingScore {
  const p = BN.isBN(points) ? points : new BN(points.toString());
  const a = BN.isBN(amount) ? amount : new BN(amount.toString());

  const avgHoldSeconds = a.isZero() ? 0 : Number(p.div(a).toString());
  const avgHoldDays = avgHoldSeconds / 86400;

  let tier = TIERS[0];
  let nextTier: Tier | null = TIERS[1];
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (avgHoldSeconds >= TIERS[i].minSeconds) {
      tier = TIERS[i];
      nextTier = TIERS[i + 1] ?? null;
      break;
    }
  }

  const progress = nextTier
    ? Math.min(
        1,
        (avgHoldSeconds - tier.minSeconds) /
          (nextTier.minSeconds - tier.minSeconds)
      )
    : 1;

  return { tier, nextTier, avgHoldSeconds, avgHoldDays, progress };
}
