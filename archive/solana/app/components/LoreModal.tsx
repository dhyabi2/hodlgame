"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { addressUrl, shortAddress, NETWORK_LABEL } from "@/lib/explorer";
import { PROGRAM_ID } from "@/lib/program";

const FAQ: { q: string; a: string }[] = [
  {
    q: "What actually happens when I stake?",
    a: "Your tokens move into an on-chain vault. No tax going in. From that moment, every token you hold accrues points — amount × seconds held — and points are what earn you rebates.",
  },
  {
    q: "What's the 20% exit tax?",
    a: "Leave early and 20% of what you withdraw is taken: 5% is burned forever (gone from supply), 15% goes to the jackpot vault that pays everyone who stayed.",
  },
  {
    q: "Is there any way to avoid the tax?",
    a: "No. It's enforced by the program itself rather than by an operator, so nobody can waive it — including whoever deployed it. The only way to not pay it is to not leave.",
  },
  {
    q: "How do rebates work?",
    a: "The vault's balance is distributed proportionally to points. Longer hold × bigger stake = larger share. Claim any time from Your Position; claiming does not reset your hold clock.",
  },
  {
    q: "What does it cost to play?",
    a: "Only Solana network fees, which on devnet are fractions of a cent in devnet SOL. There's no house cut beyond the 1% swap fee, and that stays in the pool.",
  },
  {
    q: "Is this real money?",
    a: `No. This runs on Solana ${NETWORK_LABEL.toLowerCase()} — the tokens are play money. Treat it as a game.`,
  },
];

export function LoreModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"lore" | "faq">("lore");

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="The story & how it works"
        aria-label="Open the story and FAQ"
        className="rounded-lg border border-holder-700 bg-holder-800/60 w-10 h-10 flex items-center justify-center text-lg hover:border-holder-accent transition"
      >
        <span aria-hidden>📜</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="The Legend and FAQ"
        header={
          <div
            role="tablist"
            aria-label="Story or FAQ"
            className="flex bg-holder-900 rounded-lg p-1"
          >
            {(
              [
                ["lore", "The Legend"],
                ["faq", "FAQ"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`px-4 min-h-[36px] rounded-md text-sm font-semibold transition ${
                  tab === id
                    ? "bg-holder-accent text-holder-900"
                    : "text-ink-300 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {tab === "lore" ? (
          <div className="space-y-3 text-sm text-ink-200 leading-relaxed">
            <p className="text-lg font-display font-bold text-holder-accent">
              The Vault remembers.
            </p>
            <p>
              Long ago, the market learned a simple truth: most hands are paper.
              They fold at the first red candle, and their panic has always been
              someone else&apos;s profit.
            </p>
            <p>
              The Vault was built to make that law explicit. Anyone may enter
              freely. But the doors tax the fearful on the way out — a fifth of
              everything they carry. Part of it burns, gone from this world
              entirely. The rest is set aside for the ones still inside.
            </p>
            <p>
              Time is the only ledger that matters here. Hold, and your name
              climbs the tiers — Paper, Bronze, Silver, Gold, Diamond, and
              beyond, into Adamantium. Hold, and a larger share of every
              deserter's tax finds its way to you.
            </p>
            <p className="text-holder-jackpot font-medium">
              Paper hands pay the tax. Diamond hands collect it.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {FAQ.map((item) => (
              <div key={item.q}>
                <p className="text-sm font-bold text-ink-100">{item.q}</p>
                <p className="text-sm text-ink-200 mt-1 leading-relaxed">
                  {item.a}
                </p>
              </div>
            ))}
            <div className="pt-3 border-t border-holder-700/60">
              <p className="text-xs text-ink-400">
                Program:{" "}
                <a
                  href={addressUrl(PROGRAM_ID.toBase58())}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-ink-200 hover:text-holder-accent underline underline-offset-2"
                >
                  {shortAddress(PROGRAM_ID.toBase58(), 6)} ↗
                </a>
              </p>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
