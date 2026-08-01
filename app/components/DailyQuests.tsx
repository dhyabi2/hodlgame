"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BN } from "@coral-xyz/anchor";
import {
  actedToday,
  buildQuests,
  recordVisit,
  type Quest,
} from "@/lib/daily";

export function DailyQuests({
  position,
  refreshTick,
}: {
  position: { amount: BN; points: BN } | null;
  refreshTick: number;
}) {
  const [streak, setStreak] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [acted, setActed] = useState(false);

  useEffect(() => {
    const state = recordVisit();
    setStreak(state.streak);
    setActed(actedToday());
    setMounted(true);
  }, []);

  // An action elsewhere on the page (stake/swap/claim) bumps refreshTick, so
  // re-read the flag rather than leaving the quest stale until reload.
  useEffect(() => {
    if (mounted) setActed(actedToday());
  }, [refreshTick, mounted]);

  const isStaked = !!position && position.amount.gtn(0);
  const quests: Quest[] = buildQuests({
    visited: mounted,
    isStaked,
    acted,
  });
  const doneCount = quests.filter((q) => q.done).length;
  const allDone = doneCount === quests.length;

  if (!mounted) return null;

  return (
    <div className="panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-slate-400">
          Today at the Vault
        </h3>
        <span
          className="text-sm font-bold text-holder-jackpot"
          title="Consecutive days you've checked in"
        >
          🔥 {streak}-day streak
        </span>
      </div>

      <div className="space-y-2">
        {quests.map((q, i) => (
          <motion.div
            key={q.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.06 }}
            className={`flex items-start gap-3 rounded-xl p-3 border ${
              q.done
                ? "bg-holder-success/10 border-holder-success/40"
                : "bg-holder-900/50 border-holder-700"
            }`}
          >
            <span className="text-lg leading-none mt-0.5">
              {q.done ? "✅" : "⬜"}
            </span>
            <div>
              <p
                className={`text-sm font-medium ${
                  q.done ? "text-holder-success" : "text-slate-300"
                }`}
              >
                {q.label}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">{q.hint}</p>
            </div>
          </motion.div>
        ))}
      </div>

      <p className="text-center text-xs text-slate-500">
        {allDone
          ? "🏆 All done today — come back tomorrow to extend your streak."
          : `${doneCount}/${quests.length} complete · streak resets if you miss a day`}
      </p>
    </div>
  );
}
