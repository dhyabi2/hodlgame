"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Header } from "@/components/Header";
import { AmbientParticles } from "@/components/AmbientParticles";
import { SplashIntro } from "@/components/SplashIntro";
import { GameCard } from "@/components/GameCard";
import { EmptyState, LoadError, Skeleton } from "@/components/ui";
import { fetchAllGames, type GameSummary } from "@/lib/games";
import { NETWORK_LABEL } from "@/lib/explorer";

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; games: GameSummary[]; truncated: boolean };

type List = "hot" | "new" | "mc";

const TICKER = [
  "Creator can only own 5%",
  "95% goes to the community",
  "Hold to earn — paper hands pay the tax",
  "Supply locked forever",
  "Liquidity is non-withdrawable",
  "No rug — it's in the code",
];

function isRisky(g: GameSummary) {
  return g.mintAuthorityRevoked === false || g.freezeAuthorityRevoked === false;
}

export default function Home() {
  const { connection } = useConnection();
  const reduceMotion = useReducedMotion();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<List>("hot");
  const [lockedOnly, setLockedOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchAllGames(connection)
      .then(({ games, truncated }) => {
        if (!cancelled) setState({ kind: "ready", games, truncated });
      })
      .catch((err) => {
        console.error("games load error", err);
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, attempt]);

  const games =
    state.kind === "ready"
      ? state.games
          .filter((g) => {
            const q = query.trim().toLowerCase();
            const matchQuery =
              !q ||
              g.name.toLowerCase().includes(q) ||
              g.symbol.toLowerCase().includes(q) ||
              g.mint.toLowerCase().startsWith(q);
            if (!matchQuery) return false;
            if (lockedOnly && isRisky(g)) return false;
            return true;
          })
          .slice()
          .sort((a, b) => {
            if (list === "new") return b.createdAt - a.createdAt;
            if (list === "mc")
              return (b.marketCapSol ?? -1) - (a.marketCapSol ?? -1);
            // hot: 24h price change desc; fall back to most staked when there
            // is no price history yet.
            const ac = a.change24hPct;
            const bc = b.change24hPct;
            if (ac !== null && bc !== null) return bc - ac;
            if (ac !== null) return -1;
            if (bc !== null) return 1;
            return b.totalStaked.cmp(a.totalStaked);
          })
      : [];

  const lists: { id: List; label: string }[] = [
    { id: "hot", label: "🔥 Hot" },
    { id: "new", label: "🆕 New" },
    { id: "mc", label: "💎 Top MC" },
  ];

  return (
    <>
      <AmbientParticles />
      <SplashIntro />

      <main className="min-h-screen px-4 sm:px-6 relative">
        <Header />

        {/* Ticker */}
        <div className="-mx-4 sm:-mx-6 border-y border-holder-700/60 bg-holder-900/60 overflow-hidden">
          <div className="flex w-max animate-marquee gap-8 py-2">
            {[...TICKER, ...TICKER].map((t, i) => (
              <span
                key={i}
                className="text-xs text-ink-300 whitespace-nowrap flex items-center gap-8"
              >
                <span>{t}</span>
                <span className="text-holder-accent" aria-hidden>
                  ✦
                </span>
              </span>
            ))}
          </div>
        </div>

        <div className="max-w-6xl mx-auto pb-16 relative z-10">
          {/* Hero */}
          <div className="py-10 sm:py-14 text-center space-y-4">
            <h1 className="font-display text-4xl sm:text-6xl font-bold metallic-text text-balance">
              The fun way to hold
            </h1>
            <p className="text-base sm:text-lg text-ink-300 max-w-md mx-auto text-balance">
              Launch a coin. You keep 5%. Holders get paid.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <a
                href="/create"
                className="px-8 min-h-[52px] flex items-center justify-center rounded-xl font-bold bg-holder-accent text-holder-950 hover:bg-holder-accentBright shadow-glow-accent transition"
              >
                Start a new coin
              </a>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between gap-3 flex-wrap pb-4">
            <div className="flex items-center gap-2">
              {lists.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setList(l.id)}
                  className={`px-4 min-h-[36px] rounded-full text-sm font-semibold border transition ${
                    list === l.id
                      ? "bg-holder-accent text-holder-950 border-holder-accent"
                      : "border-holder-700 text-ink-300 hover:border-holder-accent hover:text-holder-accent"
                  }`}
                >
                  {l.label}
                </button>
              ))}
              <button
                onClick={() => setLockedOnly((v) => !v)}
                aria-pressed={lockedOnly}
                className={`px-4 min-h-[36px] rounded-full text-sm font-semibold border transition ${
                  lockedOnly
                    ? "border-holder-accent/60 text-holder-accent bg-holder-accent/10"
                    : "border-holder-700 text-ink-300 hover:border-holder-accent hover:text-holder-accent"
                }`}
              >
                ✓ Locked only
              </button>
            </div>
            {state.kind === "ready" && state.games.length > 0 && (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search coin or mint"
                aria-label="Search coins"
                className="min-h-[40px] w-56 max-w-full rounded-xl bg-holder-900 border border-holder-700 px-3 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-holder-accent"
              />
            )}
          </div>

          {/* Grid */}
          {state.kind === "loading" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-48" />
              ))}
            </div>
          )}

          {state.kind === "error" && (
            <div className="panel p-8">
              <LoadError
                what="the coin directory"
                onRetry={() => setAttempt((a) => a + 1)}
              />
            </div>
          )}

          {state.kind === "ready" && state.games.length === 0 && (
            <div className="panel">
              <EmptyState
                icon="🌱"
                title="No coins yet."
                body="Be the first — launch a coin where you can only own 5%."
                action={{ label: "Start a new coin", href: "/create" }}
              />
            </div>
          )}

          {state.kind === "ready" && state.games.length > 0 && games.length === 0 && (
            <div className="panel">
              <EmptyState
                icon="🔍"
                title="No matches"
                body={`Nothing matches "${query}". Try a different name, ticker or mint.`}
              />
            </div>
          )}

          {games.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {games.map((game) => (
                <GameCard key={game.mint} game={game} />
              ))}
            </div>
          )}

          {state.kind === "ready" && state.truncated && (
            <p className="text-xs text-ink-500 text-center pt-4">
              Showing the {state.games.length} largest vaults. Paste a mint in
              the search box to jump straight to one.
            </p>
          )}

          <footer className="text-center text-xs text-ink-500 pt-8">
            {NETWORK_LABEL} · Nothing here is financial advice.
          </footer>
        </div>
      </main>
    </>
  );
}
