"use client";

import { useState } from "react";
import confetti from "canvas-confetti";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { Skeleton } from "./ui";
import { useToast } from "@/lib/toast";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

const EGG_CLICKS = 7;

const STEPS = [
  { icon: "💎", title: "Stake", body: "Lock your coins." },
  { icon: "⏳", title: "Hold", body: "Leave early, pay 20%." },
  { icon: "🎉", title: "Earn", body: "Get a share of the tax." },
];

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

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [14, -14]), {
    stiffness: 150,
    damping: 18,
  });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-14, 14]), {
    stiffness: 150,
    damping: 18,
  });

  const onMove = (e: React.MouseEvent<HTMLElement>) => {
    if (reduceMotion) return;
    const rect = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - rect.left) / rect.width - 0.5);
    my.set((e.clientY - rect.top) / rect.height - 0.5);
  };
  const onLeave = () => {
    mx.set(0);
    my.set(0);
  };

  // More staked = faster spin. Bigger jackpot = brighter glow. Both driven by
  // real on-chain state rather than being purely decorative.
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
          colors: ["#a5f9c0", "#2ee57a"],
        });
      }
    }
  };

  return (
    // Was a bare `div` with an onClick — not focusable, not keyboard-operable,
    // and invisible to assistive tech.
    <motion.button
      type="button"
      onClick={poke}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      aria-label="The vault diamond. Spins faster the more is staked."
      style={reduceMotion ? undefined : { rotateX, rotateY, transformPerspective: 500 }}
      className="relative block w-28 h-28 md:w-36 md:h-36 mx-auto rounded-full cursor-pointer select-none"
    >
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-holder-jackpot blur-2xl animate-pulse-glow"
        style={{ opacity: glowOpacity }}
      />
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        className="relative w-full h-full glow-accent animate-spin-slow"
        style={{ animationDuration: `${spinSeconds}s` }}
      >
        <polygon points="50,5 90,35 50,95 10,35" fill="url(#diamondBody)" />
        <polygon points="50,5 90,35 50,45" fill="#7df5ac" opacity="0.85" />
        <polygon points="50,5 10,35 50,45" fill="#2ee57a" opacity="0.7" />
        <polygon points="10,35 50,45 50,95" fill="#0d8f4a" opacity="0.8" />
        <polygon points="90,35 50,45 50,95" fill="#0e7a42" opacity="0.8" />
        <defs>
          <linearGradient id="diamondBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a5f9c0" />
            <stop offset="50%" stopColor="#2ee57a" />
            <stop offset="100%" stopColor="#089a4f" />
          </linearGradient>
        </defs>
      </svg>
    </motion.button>
  );
}

export function DiamondHero({
  jackpot,
  totalStaked,
  loading = false,
  symbol = "tokens",
  onPrimary,
  primaryLabel,
}: {
  jackpot: number;
  totalStaked: number;
  loading?: boolean;
  symbol?: string;
  onPrimary?: () => void;
  primaryLabel?: string;
}) {
  return (
    <div className="panel panel-hero p-6 sm:p-8 text-center space-y-6">
      <div className="space-y-3">
        <Diamond jackpot={jackpot} totalStaked={totalStaked} />
        <p className="text-base sm:text-lg text-ink-200 max-w-md mx-auto text-balance">
          Hold to earn. <strong className="text-ink-100">Paper hands pay.</strong>
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mx-auto">
        {loading ? (
          <>
            <StatSkeleton />
            <StatSkeleton />
          </>
        ) : (
          <>
            <Stat
              label="Reward pool"
              symbol={symbol}
              value={jackpot}
              note="Paid out to holders"
              tone="text-holder-jackpot"
              border="border-holder-jackpot/30"
            />
            <Stat
              label="Total staked"
              symbol={symbol}
              value={totalStaked}
              note="Locked right now"
              tone="text-ink-100"
              border="border-holder-700"
            />
          </>
        )}
      </div>

      {/* The loop, stated in three beats, above the fold. */}
      <ol className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-left">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="rounded-xl border border-holder-700/70 bg-holder-900/40 p-3 flex items-start gap-3"
          >
            <span className="text-xl leading-none" aria-hidden>
              {step.icon}
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-100">
                {i + 1}. {step.title}
              </p>
              <p className="text-xs text-ink-300 mt-0.5">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {onPrimary && primaryLabel && (
        <button
          onClick={onPrimary}
          className="w-full sm:w-auto px-8 min-h-[48px] rounded-xl font-bold bg-holder-accent text-holder-900 hover:bg-holder-accentBright shadow-glow-accent transition"
        >
          {primaryLabel}
        </button>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
  border,
  symbol,
}: {
  label: string;
  value: number;
  note: string;
  tone: string;
  border: string;
  symbol: string;
}) {
  return (
    <div className={`rounded-xl bg-holder-900/60 border ${border} p-4`}>
      <p className="text-xs uppercase tracking-wider text-ink-300">{label}</p>
      <p className={`text-2xl md:text-3xl font-bold stat-number mt-1 ${tone}`}>
        <AnimatedNumber value={value} decimals={2} />{" "}
        <span className="text-base font-normal opacity-70">{symbol}</span>
      </p>
      <p className="text-xs text-ink-400 mt-1">{note}</p>
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="rounded-xl bg-holder-900/60 border border-holder-700 p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-36 mt-2" />
      <Skeleton className="h-3 w-40 mt-2" />
    </div>
  );
}
