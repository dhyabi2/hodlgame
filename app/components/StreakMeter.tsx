"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { getHoldingScore, getTierLabel } from "@/lib/tiers";
import { PROGRAM_ID } from "@/lib/program";
import idl from "@/lib/idl.json";

export function StreakMeter({
  points,
  amount,
}: {
  points: BN | string | number;
  amount: BN | string | number;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const score = getHoldingScore(points, amount);
  const { tier, nextTier, avgHoldDays, progress } = score;
  const [percentile, setPercentile] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program<any>(idl as any, PROGRAM_ID, provider);

    const fetchPercentile = async () => {
      try {
        const all = await (program.account as any).stakeAccount.all();
        const mySeconds = score.avgHoldSeconds;
        const others = all.filter(
          (a: any) =>
            a.account.amount.gtn(0) &&
            !(wallet.publicKey && a.account.owner.equals(wallet.publicKey))
        );
        if (others.length === 0) {
          if (!cancelled) setPercentile(null);
          return;
        }
        const behind = others.filter((a: any) => {
          const otherScore = getHoldingScore(a.account.points, a.account.amount);
          return otherScore.avgHoldSeconds <= mySeconds;
        }).length;
        if (!cancelled) {
          setPercentile(Math.round((behind / others.length) * 100));
        }
      } catch (err) {
        console.error("percentile fetch error", err);
      }
    };

    fetchPercentile();
    const id = setInterval(fetchPercentile, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, wallet.publicKey, score.avgHoldSeconds]);

  return (
    <div className="rounded-2xl border border-holder-700 bg-holder-800/60 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-slate-400">
          Diamond Hands Score
        </h3>
        <span className={`text-lg font-bold ${tier.color}`}>
          {tier.emoji} {getTierLabel(score)}
        </span>
      </div>

      <div>
        <div className="h-3 rounded-full bg-holder-900 overflow-hidden">
          <motion.div
            className={`h-full bg-gradient-to-r from-holder-accent to-holder-success ${
              !nextTier ? "animate-pulse-glow" : ""
            }`}
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
            <span>Max tier — still climbing</span>
          )}
        </div>
      </div>

      {percentile !== null && (
        <p className="text-center text-sm text-holder-success font-medium">
          🔥 You're holding longer than {percentile}% of stakers
        </p>
      )}

      <ShareButton tierName={tier.name} tierEmoji={tier.emoji} avgHoldDays={avgHoldDays} />
    </div>
  );
}

function ShareButton({
  tierName,
  tierEmoji,
  avgHoldDays,
}: {
  tierName: string;
  tierEmoji: string;
  avgHoldDays: number;
}) {
  const share = () => {
    const url = typeof window !== "undefined" ? window.location.origin : "";
    const text = `${tierEmoji} I'm a ${tierName} hand on Holder — ${avgHoldDays.toFixed(
      1
    )} days average hold. Paper hands pay the tax, diamond hands collect it. 💎🙌`;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      text
    )}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  };

  return (
    <button
      onClick={share}
      className="w-full py-2 rounded-xl text-sm font-medium border border-holder-700 text-slate-300 hover:border-holder-accent hover:text-holder-accent transition"
    >
      𝕏 Share your streak
    </button>
  );
}
