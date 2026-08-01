"use client";

import { AnimatedNumber } from "./AnimatedNumber";

function Diamond() {
  return (
    <div className="relative w-32 h-32 md:w-40 md:h-40 mx-auto">
      <div className="absolute inset-0 rounded-full bg-holder-accent/20 blur-2xl animate-pulse-glow" />
      <svg
        viewBox="0 0 100 100"
        className="relative w-full h-full glow-accent animate-spin-slow"
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

export function DiamondHero({
  jackpot,
  totalStaked,
}: {
  jackpot: number;
  totalStaked: number;
}) {
  return (
    <div className="rounded-2xl border border-holder-700 bg-gradient-to-b from-holder-800/80 to-holder-900/40 p-8 text-center space-y-6">
      <Diamond />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mx-auto">
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
      </div>
    </div>
  );
}
