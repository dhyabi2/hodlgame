"use client";

import { useState } from "react";
import { formatAmount } from "@/lib/amount";
import { addressUrl, shortAddress } from "@/lib/explorer";
import { safetyFlags, type GameSummary } from "@/lib/games";
import { SectionTitle } from "./ui";

const LEVEL_STYLES = {
  good: {
    dot: "bg-holder-success",
    text: "text-holder-success",
    icon: "✓",
    word: "Safe",
  },
  warn: {
    dot: "bg-holder-jackpot",
    text: "text-holder-jackpot",
    icon: "!",
    word: "Caution",
  },
  danger: {
    dot: "bg-holder-danger",
    text: "text-holder-dangerBright",
    icon: "✕",
    word: "Risk",
  },
} as const;

/**
 * Open launching means anyone can put a predatory token in front of a user.
 * This panel does not vouch for anything — it states the two facts that decide
 * whether a stranger's token can take your money (can they print more? can they
 * freeze yours?) and puts the dangerous ones at the top, expanded.
 */
export function SafetyPanel({ game }: { game: GameSummary }) {
  const flags = safetyFlags(game);
  const dangers = flags.filter((f) => f.level === "danger");
  const [open, setOpen] = useState(dangers.length > 0);

  const headline =
    dangers.length > 0
      ? { tone: "danger" as const, text: `${dangers.length} serious risk${dangers.length === 1 ? "" : "s"}` }
      : { tone: "good" as const, text: "Key protections in place" };

  const style = LEVEL_STYLES[headline.tone];

  return (
    <div
      className={`panel p-5 sm:p-6 space-y-4 ${
        dangers.length > 0 ? "border-holder-danger/40" : ""
      }`}
    >
      <SectionTitle
        as="h3"
        right={
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="min-h-[36px] px-3 rounded-lg border border-holder-700 text-xs text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
          >
            {open ? "Hide details" : "Show details"}
          </button>
        }
      >
        <span className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${style.dot}`} aria-hidden />
          <span className={style.text}>{headline.text}</span>
        </span>
      </SectionTitle>

      {open && (
        <ul className="space-y-2">
          {flags.map((flag) => {
            const s = LEVEL_STYLES[flag.level];
            return (
              <li
                key={flag.label}
                className="flex items-start gap-3 rounded-xl bg-holder-900/50 border border-holder-700/60 p-3"
              >
                <span
                  className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-holder-950 ${s.dot}`}
                  aria-hidden
                >
                  {s.icon}
                </span>
                <div>
                  <p className={`text-sm font-semibold ${s.text}`}>
                    <span className="sr-only">{s.word}: </span>
                    {flag.label}
                  </p>
                  <p className="text-xs text-ink-300 mt-0.5 leading-relaxed">
                    {flag.detail}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
        <Fact label="Creator">
          <a
            href={addressUrl(game.authority)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-ink-200 hover:text-holder-accent underline underline-offset-2"
          >
            {shortAddress(game.authority)}
          </a>
        </Fact>
        <Fact label="Total supply">
          <span className="stat-number tabular-nums text-ink-200">
            {game.supply === null
              ? "—"
              : formatAmount(game.supply, game.decimals, { min: 0, max: 0 })}
          </span>
        </Fact>
        <Fact label="Token">
          <a
            href={addressUrl(game.mint)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-ink-200 hover:text-holder-accent underline underline-offset-2"
          >
            {shortAddress(game.mint)}
          </a>
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-holder-900/40 p-3">
      <dt className="text-ink-400 uppercase tracking-wide text-[11px]">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
