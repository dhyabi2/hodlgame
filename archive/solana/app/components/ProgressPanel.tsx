"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { motion } from "framer-motion";
import { BN } from "@coral-xyz/anchor";
import { getHoldingScore, getTierLabel, TIERS } from "@/lib/tiers";
import { actedToday, buildQuests, recordVisit, type Quest } from "@/lib/daily";
import { useStakers } from "@/lib/stakers";
import { useToast } from "@/lib/toast";

/**
 * The tier meter and the daily quests were two separate cards describing the
 * same thing — how you're doing. They're one card now, which also pulls the
 * primary action list up a full screen on mobile.
 */
export function ProgressPanel({
  position,
  refreshTick,
}: {
  position: { amount: BN; points: BN } | null;
  refreshTick: number;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const { stakers } = useStakers();
  const [acted, setActed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    recordVisit();
    setActed(actedToday());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) setActed(actedToday());
  }, [refreshTick, mounted]);

  const isStaked = !!position && position.amount.gtn(0);
  const score = position
    ? getHoldingScore(position.points, position.amount)
    : getHoldingScore(new BN(0), new BN(0));
  const { tier, avgHoldDays, progress, avgHoldSeconds } = score;

  const me = wallet.publicKey?.toBase58();
  const others = (stakers ?? []).filter((s) => s.owner !== me);
  const percentile =
    isStaked && others.length > 0
      ? Math.round(
          (others.filter((s) => s.avgHoldSeconds <= avgHoldSeconds).length /
            others.length) *
            100
        )
      : null;

  const quests: Quest[] = buildQuests({ visited: mounted, isStaked, acted });
  const doneCount = quests.filter((q) => q.done).length;

  if (!mounted) return null;

  const share = async () => {
    const url = typeof window !== "undefined" ? window.location.origin : "";
    const text = `${tier.emoji} I'm a ${tier.name} hand on HoldFun — ${avgHoldDays.toFixed(
      1
    )} days average hold. Paper hands pay the tax, diamond hands collect it. 💎🙌`;
    // Native share on mobile, X intent on desktop, clipboard if both are absent.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "HoldFun", text, url });
        return;
      } catch {
        /* user cancelled — fall through to the intent */
      }
    }
    if (typeof window !== "undefined") {
      window.open(
        `https://twitter.com/intent/tweet?text=${encodeURIComponent(
          text
        )}&url=${encodeURIComponent(url)}`,
        "_blank",
        "noopener,noreferrer"
      );
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      toast.push("success", "Link copied", "Send it to someone with weak hands.");
    } catch {
      toast.push("danger", "Couldn't copy", "Your browser blocked clipboard access.");
    }
  };

  return (
    <div id="progress" className="panel p-5 sm:p-6 space-y-4 scroll-mt-24">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span aria-hidden>{tier.emoji}</span>
          <span className={`text-lg font-bold ${tier.color}`}>{getTierLabel(score)}</span>
          <span className="text-xs text-ink-400 tabular-nums truncate">
            {isStaked ? `${avgHoldDays.toFixed(1)}d avg hold` : "not staked"}
          </span>
        </span>
        <span className="text-xs text-ink-400 shrink-0">{open ? "Hide" : "Details"}</span>
      </button>

      <div className="h-2 rounded-full bg-holder-900 overflow-hidden">
        <motion.div
          className="h-full bg-gradient-to-r from-holder-accent to-holder-violet"
          initial={{ width: 0 }}
          animate={{ width: `${progress * 100}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>

      {open && (
        <div className="space-y-4 pt-1 border-t border-holder-700/60">
          {percentile !== null && (
            <p className="text-center text-sm text-holder-success font-medium">
              🔥 Holding longer than {percentile}% of stakers
            </p>
          )}

          <ol className="flex items-center justify-between gap-1 pt-1">
            {TIERS.map((t) => {
              const reached = avgHoldSeconds >= t.minSeconds && isStaked;
              return (
                <li
                  key={t.name}
                  title={`${t.name} — ${(t.minSeconds / 86400).toFixed(0)} days`}
                  className={`text-center flex-1 ${reached ? "" : "opacity-35 grayscale"}`}
                >
                  <span className="text-base" aria-hidden>
                    {t.emoji}
                  </span>
                  <p className="text-[11px] text-ink-400 leading-tight truncate">
                    {t.name}
                  </p>
                </li>
              );
            })}
          </ol>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-300">
                Today
              </h4>
              <span className="text-xs text-ink-300 tabular-nums">
                {doneCount}/{quests.length}
              </span>
            </div>
            <ul className="space-y-2">
              {quests.map((q, i) => (
                <motion.li
                  key={q.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className={`flex items-start gap-3 rounded-xl p-3 border ${
                    q.done
                      ? "bg-holder-success/10 border-holder-success/40"
                      : "bg-holder-900/50 border-holder-700"
                  }`}
                >
                  <span className="text-lg leading-none mt-0.5" aria-hidden>
                    {q.done ? "✅" : "⬜"}
                  </span>
                  <div>
                    <p
                      className={`text-sm font-medium ${
                        q.done ? "text-holder-success" : "text-ink-100"
                      }`}
                    >
                      {q.label}
                      <span className="sr-only">
                        {q.done ? " — complete" : " — not yet done"}
                      </span>
                    </p>
                    <p className="text-xs text-ink-400 mt-0.5">{q.hint}</p>
                  </div>
                </motion.li>
              ))}
            </ul>
          </div>

          <div className="flex gap-2">
            <button
              onClick={share}
              className="flex-1 min-h-[44px] rounded-xl text-sm font-semibold border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
            >
              Share
            </button>
            <button
              onClick={copyLink}
              aria-label="Copy link to HoldFun"
              className="min-h-[44px] px-4 rounded-xl text-sm border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
            >
              <span aria-hidden>🔗</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
