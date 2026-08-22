"use client";

// First-visit welcome gate: what makes the game different, told through its
// REAL mechanisms in plain language, followed by the Terms — the app is
// reachable only after an explicit Accept (stored per-browser). Stark
// monochrome, same design system as the rest of the app.

import { useEffect, useRef, useState } from "react";

export const TERMS_KEY = "holdfun-terms-accepted"; // legacy prefix — do not rename (see VERCEL.md)

export function useTermsAccepted(): [boolean | null, () => void] {
  const [accepted, setAccepted] = useState<boolean | null>(null);
  useEffect(() => {
    try { setAccepted(localStorage.getItem(TERMS_KEY) === "1"); } catch { setAccepted(true); }
  }, []);
  const accept = () => {
    try { localStorage.setItem(TERMS_KEY, "1"); } catch {}
    setAccepted(true);
  };
  return [accepted, accept];
}

const MECHANISMS: { n: string; title: string; body: string }[] = [
  {
    n: "01",
    title: "No one can rug you",
    body: "On most platforms the insiders hold the bag — here they can't. Every coin's creator is capped at 5% forever; 95% belongs to the community from the first second. And there is no smart contract to exploit, because there is no contract at all: the entire game is replayed from public, signed ledger data that your own browser can re-check.",
  },
  {
    n: "02",
    title: "Quitters pay the holders",
    body: "Leaving early has a price — 20% of every unstake. A quarter of that tax is burned forever, so everyone's share of the coin grows. The rest is paid out, in real XNO, to everyone still staked. Elsewhere, the fastest exit wins. Here, patience is the strategy that gets paid.",
  },
  {
    n: "03",
    title: "The pool can't be emptied",
    body: "Liquidity is mathematically protected: no trade can drain the pool — not a whale, not the creator, not anyone. Every XNO paid in stays in the pool, backing the price for everyone who remains. Anyone trying to buy it all only makes the remaining holders richer.",
  },
  {
    n: "04",
    title: "Zero fees eat zero profit",
    body: "The game settles on a feeless, sub-second network. No gas. No cut taken out of your trade on the way in or the way out. What the math says you get is what you get.",
  },
  {
    n: "05",
    title: "Don't trust — verify",
    body: "One click in the Explorer re-computes the entire game inside your browser and compares fingerprints with the site. If we ever lied about a single balance, you could prove it in seconds. That's the standard everything here is held to.",
  },
];

const TERMS: { h: string; p: string }[] = [
  {
    h: "1. Acceptance",
    p: "By clicking Accept and using HodlGame you agree to these Terms. If you do not agree, do not use the platform. We may update these Terms; continued use after changes means you accept them.",
  },
  {
    h: "2. Eligibility",
    p: "You must be at least 18 years old and legally permitted to use this platform in your jurisdiction. You may not use HodlGame if you are located in, or a resident of, any jurisdiction where doing so is prohibited, or if you are subject to sanctions.",
  },
  {
    h: "3. Nature of the platform",
    p: "HodlGame is a self-custodial interface to a public, deterministic ledger game. Coins launched here are community game tokens created by users, not by us. They have no intrinsic value, represent no ownership, equity, debt, or claim against anyone, and are not offered as securities or investments of any kind.",
  },
  {
    h: "4. Risk disclosure",
    p: "Trading game tokens is extremely risky. Prices are volatile and can go to zero at any time. You can lose everything you put in. Liquidity, mechanics, and taxes described in the interface are enforced by open protocol rules, not by promises. Never commit funds you cannot afford to lose entirely.",
  },
  {
    h: "5. No advice, no guarantees",
    p: "Nothing on HodlGame is financial, investment, legal, or tax advice. Descriptions of game mechanics explain how the protocol's rules work — they are not a promise of profit or performance. No outcome is guaranteed, ever.",
  },
  {
    h: "6. Your keys, your responsibility",
    p: "You alone control your wallet, seed, and password. We never hold them and cannot recover them. Anything sent to a wrong address, any lost seed, and any action signed by your keys is irreversible and entirely your responsibility.",
  },
  {
    h: "7. Prohibited conduct",
    p: "You agree not to use the platform for market manipulation, wash trading, fraud, money laundering, sanctions evasion, or any unlawful purpose; not to launch tokens that infringe others' rights or impersonate others; and not to attack, overload, or attempt to subvert the platform or protocol.",
  },
  {
    h: "8. User-created content",
    p: "Token names, images, descriptions, and comments are created by users. We may remove or hide content that is unlawful or violates these Terms, but we do not endorse, verify, or take responsibility for any user-created token or content.",
  },
  {
    h: "9. Taxes",
    p: "You are solely responsible for determining and paying any taxes that apply to your activity on the platform.",
  },
  {
    h: "10. As-is; limitation of liability",
    p: "The platform is provided as-is and as-available, without warranties of any kind. To the maximum extent permitted by law, we are not liable for any losses or damages arising from your use of the platform, including loss of funds, tokens, profits, or data, whether from protocol behavior, network conditions, third-party services, or interruptions.",
  },
];

export default function Welcome({ onAccept }: { onAccept: () => void }) {
  const termsRef = useRef<HTMLDivElement>(null);
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 py-16 sm:py-24">
        {/* hero */}
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-neutral-500">Welcome to</p>
        <div className="mt-2 flex items-start justify-between gap-4">
          <h1 className="text-5xl sm:text-7xl font-black tracking-tight leading-none">HODLGAME</h1>
          <a
            href="https://github.com/dhyabi2/holdergame"
            target="_blank"
            rel="noreferrer"
            title="Open source on GitHub — verify the code yourself"
            className="mt-2 text-neutral-500 hover:text-white shrink-0"
          >
            <svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" aria-label="GitHub">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        </div>
        <p className="mt-6 text-xl sm:text-2xl font-bold text-neutral-200 leading-snug">
          The game where holding wins.
        </p>
        <p className="mt-3 text-neutral-400 leading-relaxed">
          Most platforms reward whoever exits first — the patient are left holding the bag.
          This game inverts that: the rules themselves pay the people who stay.
          Not luck. Not promises. Protocol.
        </p>
        <button
          className="mt-8 rounded-none bg-white px-6 py-3 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200"
          onClick={() => termsRef.current?.scrollIntoView({ behavior: "smooth" })}
        >
          How it works ↓
        </button>

        {/* mechanisms */}
        <div className="mt-16 space-y-12">
          {MECHANISMS.map((m) => (
            <div key={m.n} className="grid grid-cols-[3rem_1fr] gap-4">
              <span className="text-3xl font-black text-neutral-700 leading-none">{m.n}</span>
              <div>
                <h2 className="text-lg font-black">{m.title}</h2>
                <p className="mt-2 text-sm text-neutral-400 leading-relaxed">{m.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-16 border-y border-neutral-800 py-8 text-center">
          <p className="text-lg font-black">The house edge points at the quitters, not at you.</p>
          <p className="mt-2 text-sm text-neutral-500">
            High risk stays high risk — every coin can go to zero. But the rules are public,
            verifiable, and tilted toward patience.
          </p>
        </div>

        {/* terms */}
        <div ref={termsRef} className="mt-16">
          <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-neutral-500">Terms &amp; Conditions</h2>
          <div className="mt-4 max-h-80 overflow-y-auto rounded-none border border-neutral-800 bg-neutral-950 p-5 space-y-5">
            {TERMS.map((t) => (
              <div key={t.h}>
                <h3 className="text-sm font-black">{t.h}</h3>
                <p className="mt-1 text-xs text-neutral-400 leading-relaxed">{t.p}</p>
              </div>
            ))}
          </div>
          {/* The one place red is used for something other than a price:
              the user-mandated, impossible-to-miss loss disclaimer. */}
          <div className="mt-4 rounded-none border border-red-900 bg-red-950/40 p-4">
            <p className="text-sm font-black uppercase tracking-wide text-red-500">This is a game. Not an investment.</p>
            <p className="mt-1.5 text-xs text-red-400 leading-relaxed">
              Treat every coin here as a game piece, never as an asset, a security, or savings.
              Anything you put in can be lost — completely and irreversibly — and HodlGame
              bears no responsibility for any loss, of any kind, ever. Play only with money
              you could burn without blinking.
            </p>
          </div>
          <button
            className="mt-6 w-full rounded-none bg-white py-4 text-sm font-black uppercase tracking-wide text-black hover:bg-neutral-200"
            onClick={onAccept}
          >
            I am 18+ and I accept the Terms — enter HodlGame
          </button>
          <p className="mt-3 text-center text-[10px] text-neutral-600">
            By entering you confirm you have read and accepted the Terms above.
          </p>
        </div>
      </div>
    </main>
  );
}
