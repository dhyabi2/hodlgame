"use client";

import { useState } from "react";
import confetti from "canvas-confetti";
import { useReducedMotion } from "framer-motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { useToast } from "@/lib/toast";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

const EGG_CLICKS = 7;

function Diamond({
  jackpot,
  totalStaked,
}: {
  jackpot: number;
  totalStaked: number;
}) {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [clicks, setClicks] = useState(0);

  // More staked = faster spin. Bigger jackpot = brighter glow. Both react to
  // real on-chain state instead of being purely decorative.
  const spinSeconds = clamp(12 - Math.log10(totalStaked + 1) * 1.8, 3, 12);
  const glowOpacity = clamp(0.18 + Math.log10(jackpot + 1) * 0.06, 0.18, 0.55);

  const poke = () => {
    const next = clicks + 1;
    setClicks(next);
    if (next === EGG_CLICKS) {
      setClicks(0);
      toast.push(
        "info",
        "🥚 You found the crack in the diamond",
        "Nothing in here but the sound of someone still holding."
      );
      if (!reduceMotion) {
        confetti({
          particleCount: 40,
          spread: 360,
          startVelocity: 18,
          scalar: 0.7,
          origin: { y: 0.35 },
          colors: ["#a5f3fc", "#22d3ee"],
        });
      }
    }
  };

  return (
    <div
      onClick={poke}
      className="relative w-32 h-32 md:w-40 md:h-40 mx-auto cursor-pointer select-none"
    >
      <div
        className="absolute inset-0 rounded-full bg-holder-jackpot blur-2xl animate-pulse-glow"
        style={{ opacity: glowOpacity }}
      />
      <svg
        viewBox="0 0 100 100"
        className="relative w-full h-full glow-accent animate-spin-slow"
        style={{ animationDuration: `${spinSeconds}s` }}
      >
        <polygon points="50,5 90,35 50,95 10,35" fill="url(#diamondBody)" />
        <polygon points="50,5 90,35 50,45" fill="#67e8f9" opacity="0.85" />
        <polygon points="50,5 10,35 50,45" fill="#22d3ee" opacity="0.7" />
        <polygon points="10,35 50,45 50,95" fill="#0e7490" opacity="0.8" />
        <polygon points="90,35 50,45 50,95" fill="#155e75" opacity="0.8" />
        <defs>
          <linearGradient id="diamondBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a5f3fc" />
            <stop offset="50%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#0891b2" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="rounded-xl bg-holder-900/60 border border-holder-700 p-4 animate-pulse">
      <div className="h-3 w-24 bg-holder-700/60 rounded" />
      <div className="h-7 w-32 bg-holder-700/60 rounded mt-2" />
      <div className="h-3 w-36 bg-holder-700/40 rounded mt-2" />
    </div>
  );
}

export function DiamondHero({
  jackpot,
  totalStaked,
  loading = false,
}: {
  jackpot: number;
  totalStaked: number;
  loading?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-holder-700 bg-gradient-to-b from-holder-800/80 to-holder-900/40 p-8 text-center space-y-6">
      <Diamond jackpot={jackpot} totalStaked={totalStaked} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mx-auto">
        {loading ? (
          <>
            <StatSkeleton />
            <StatSkeleton />
          </>
        ) : (
          <>
            <div className="rounded-xl bg-holder-900/60 border border-holder-jackpot/30 p-4">
              <p className="text-xs uppercase tracking-wider text-holder-jackpot/80">
                Jackpot Vault
              </p>
              <p className="text-2xl md:text-3xl font-bold text-holder-jackpot mt-1">
                <AnimatedNumber value={jackpot} decimals={2} /> HOLD
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Funded entirely by paper-hands tax
              </p>
            </div>
            <div className="rounded-xl bg-holder-900/60 border border-holder-700 p-4">
              <p className="text-xs uppercase tracking-wider text-slate-400">
                Total Staked
              </p>
              <p className="text-2xl md:text-3xl font-bold mt-1">
                <AnimatedNumber value={totalStaked} decimals={2} /> HOLD
              </p>
              <p className="text-xs text-slate-500 mt-1">Diamond hands only</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
