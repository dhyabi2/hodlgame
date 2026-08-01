"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const FAQ: { q: string; a: string }[] = [
  {
    q: "What actually happens when I stake?",
    a: "Your HOLD moves into an on-chain vault. No tax going in. From that moment, every token you hold accrues points — amount × seconds held — and points are what earn you rebates.",
  },
  {
    q: "What's the 20% exit tax?",
    a: "Leave early and 20% of what you withdraw is taken: 5% is burned forever (gone from supply), 15% goes to the jackpot vault that pays everyone who stayed.",
  },
  {
    q: "How do rebates work?",
    a: "The vault's balance is distributed proportionally to points. Longer hold × bigger stake = larger share. Claim any time from Your Position.",
  },
  {
    q: "How does the Diamond Raffle pick a winner?",
    a: "Once per day, anyone can trigger the draw. Odds are weighted by points, so patience — not wallet size — improves your chances. Winner takes 10% of the vault. (Devnet note: randomness is slot-hash based, not VRF — fine for play money, not for real money.)",
  },
  {
    q: "Is this real money?",
    a: "No. This runs on Solana devnet — the tokens are play money. Treat it as a game.",
  },
];

export function LoreModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"lore" | "faq">("lore");

  // Esc closes, and the page behind shouldn't scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="The story & how it works"
        aria-label="Open lore and FAQ"
        className="rounded-lg border border-holder-700 bg-holder-800/60 w-10 h-10 flex items-center justify-center text-lg hover:border-holder-accent transition"
      >
        📜
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.96 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg max-h-[80vh] overflow-y-auto panel p-6 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex bg-holder-900 rounded-lg p-1">
                  <button
                    onClick={() => setTab("lore")}
                    className={`px-4 py-1 rounded-md text-sm font-medium transition ${
                      tab === "lore"
                        ? "bg-holder-accent text-holder-900"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    The Legend
                  </button>
                  <button
                    onClick={() => setTab("faq")}
                    className={`px-4 py-1 rounded-md text-sm font-medium transition ${
                      tab === "faq"
                        ? "bg-holder-accent text-holder-900"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    FAQ
                  </button>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="text-slate-500 hover:text-white text-xl leading-none"
                >
                  ✕
                </button>
              </div>

              {tab === "lore" ? (
                <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
                  <p className="text-lg font-display font-bold text-holder-accent">
                    The Vault remembers.
                  </p>
                  <p>
                    Long ago, the market learned a simple truth: most hands are
                    paper. They fold at the first red candle, and their panic
                    has always been someone else&apos;s profit.
                  </p>
                  <p>
                    The Vault was built to make that law explicit. Anyone may
                    enter freely. But the doors tax the fearful on the way out —
                    a fifth of everything they carry. Part of it burns, gone
                    from this world entirely. The rest is set aside for the ones
                    still inside.
                  </p>
                  <p>
                    Time is the only ledger that matters here. Hold, and your
                    name climbs the tiers — Paper, Bronze, Silver, Gold,
                    Diamond, and beyond, into Adamantium. Hold, and the Vault
                    tips its daily raffle in your favour.
                  </p>
                  <p className="text-holder-jackpot font-medium">
                    Paper hands pay the tax. Diamond hands collect it.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {FAQ.map((item) => (
                    <div key={item.q}>
                      <p className="text-sm font-bold text-slate-200">
                        {item.q}
                      </p>
                      <p className="text-sm text-slate-400 mt-1 leading-relaxed">
                        {item.a}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
