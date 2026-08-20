import { BN } from "@coral-xyz/anchor";

/**
 * Achievements are derived entirely from real on-chain data (current position
 * + parsed event history). Nothing here is stored client-side, so a badge
 * shown as unlocked is genuinely earned — you can't clear storage to fake one,
 * and you can't clear storage to lose one either.
 */

export interface AchievementInput {
  /** Currently staked amount, base units. */
  stakedAmount: BN;
  /** Time-weighted average hold, in days. */
  avgHoldDays: number;
  /** Lifetime totals from parsed event history (recent window). */
  totalStaked: BN;
  totalTaxPaid: BN;
  totalBurned: BN;
  totalClaimed: BN;
}

export interface Achievement {
  id: string;
  name: string;
  emoji: string;
  description: string;
  unlocked: boolean;
}

const ONE_HOLD = new BN(1_000_000); // 6 decimals

function holds(bn: BN, whole: number): boolean {
  return bn.gte(ONE_HOLD.muln(whole));
}

export function getAchievements(input: AchievementInput): Achievement[] {
  return [
    {
      id: "first-blood",
      name: "First Blood",
      emoji: "💎",
      description: "Stake HOLD for the first time",
      unlocked: input.stakedAmount.gtn(0) || input.totalStaked.gtn(0),
    },
    {
      id: "day-one",
      name: "Day One",
      emoji: "🌅",
      description: "Hold a position for 24 hours",
      unlocked: input.avgHoldDays >= 1,
    },
    {
      id: "whale",
      name: "Whale",
      emoji: "🐋",
      description: "Hold 10,000 HOLD staked at once",
      unlocked: holds(input.stakedAmount, 10_000),
    },
    {
      id: "diamond-hands",
      name: "Diamond Hands",
      emoji: "🙌",
      description: "Reach a 14-day average hold",
      unlocked: input.avgHoldDays >= 14,
    },
    {
      id: "adamantium",
      name: "Adamantium",
      emoji: "⚡",
      description: "Reach a 30-day average hold",
      unlocked: input.avgHoldDays >= 30,
    },
    {
      id: "rebate-collector",
      name: "Rebate Collector",
      emoji: "✨",
      description: "Claim rebates from the vault",
      unlocked: input.totalClaimed.gtn(0),
    },
    {
      id: "arsonist",
      name: "Arsonist",
      emoji: "🔥",
      description: "Burn HOLD forever by exiting early",
      unlocked: input.totalBurned.gtn(0),
    },
  ];
}
