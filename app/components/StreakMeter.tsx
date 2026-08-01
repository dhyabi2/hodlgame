"use client";

import { motion } from "framer-motion";
import { BN } from "@coral-xyz/anchor";
import { getHoldingScore } from "@/lib/tiers";

export function StreakMeter({
  points,
  amount,
}: {
  points: BN | string | number;
  amount: BN | string | number;
}) {
  const score = getHoldingScore(points, amount);
  const { tier, nextTier, avgHoldDays, progress } = score;

  return (
    <div className="rounded-2xl border border-holder-700 bg-holder-800/60 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-slate-400">
          Diamond Hands Score
        </h3>
        <span className={`text-lg font-bold ${tier.color}`}>
          {tier.emoji} {tier.name}
        </span>
      </div>

      <div>
        <div className="h-3 rounded-full bg-holder-900 overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-holder-accent to-holder-success"
            initial={{ width: 0 }}
            animate={{ width: `${progress * 100}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>
        <div className="flex justify-between text-xs text-slate-500 mt-1">
          <span>{avgHoldDays.toFixed(2)} days avg. hold</span>
          {nextTier ? (
            <span>
              Next: {nextTier.emoji} {nextTier.name} at{" "}
              {(nextTier.minSeconds / 86400).toFixed(0)}d
            </span>
          ) : (
            <span>Max tier reached</span>
          )}
        </div>
      </div>
    </div>
  );
}
