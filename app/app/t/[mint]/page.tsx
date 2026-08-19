"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { GameView } from "@/components/GameView";
import { Header } from "@/components/Header";
import { LoadError, Skeleton } from "@/components/ui";
import { MintProvider } from "@/lib/mint";
import { BalancesProvider } from "@/lib/balances";
import { StakersProvider } from "@/lib/stakers";
import { fetchGame, type GameSummary } from "@/lib/games";
import { shortAddress } from "@/lib/explorer";

type State =
  | { kind: "loading" }
  | { kind: "bad-address" }
  | { kind: "not-found" }
  | { kind: "error" }
  | { kind: "ready"; game: GameSummary };

export default function TokenGamePage({ params }: { params: { mint: string } }) {
  const { connection } = useConnection();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const mint = useMemo(() => {
    try {
      return new PublicKey(params.mint);
    } catch {
      return null;
    }
  }, [params.mint]);

  useEffect(() => {
    if (!mint) {
      setState({ kind: "bad-address" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    fetchGame(connection, mint)
      .then((game) => {
        if (cancelled) return;
        setState(game ? { kind: "ready", game } : { kind: "not-found" });
      })
      .catch((err) => {
        console.error("game load error", err);
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, mint, attempt]);

  if (state.kind === "ready" && mint) {
    return (
      <MintProvider
        mint={mint}
        decimals={state.game.decimals}
        name={state.game.name || shortAddress(state.game.mint)}
        symbol={state.game.symbol || "TOKEN"}
      >
        <BalancesProvider>
          <StakersProvider>
            <GameView game={state.game} />
          </StakersProvider>
        </BalancesProvider>
      </MintProvider>
    );
  }

  return (
    <main className="min-h-screen px-4 sm:px-6 pb-12">
      <Header />
      <div className="max-w-2xl mx-auto pt-10">
        {state.kind === "loading" && (
          <div className="panel p-8 space-y-4" role="status" aria-label="Loading game">
            <Skeleton className="h-8 w-56 mx-auto" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
            <span className="sr-only">Loading this token&apos;s vault…</span>
          </div>
        )}

        {state.kind === "bad-address" && (
          <Notice
            icon="🤔"
            title="That doesn't look like a token address"
            body={`"${params.mint.slice(0, 24)}${params.mint.length > 24 ? "…" : ""}" isn't a valid Solana address.`}
          />
        )}

        {state.kind === "not-found" && (
          <Notice
            icon="🕳️"
            title="No vault for this token"
            body="This mint exists on-chain but nobody has opened a HoldFun vault for it. If it's your token, you can launch one in about a minute."
            action={{ label: "Launch a vault", href: "/create" }}
          />
        )}

        {state.kind === "error" && (
          <div className="panel p-8">
            <LoadError what="this game" onRetry={() => setAttempt((a) => a + 1)} />
          </div>
        )}
      </div>
    </main>
  );
}

function Notice({
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="panel p-8 text-center space-y-3">
      <p className="text-5xl" aria-hidden>
        {icon}
      </p>
      <h1 className="text-xl font-display font-bold text-ink-100">{title}</h1>
      <p className="text-sm text-ink-300 max-w-sm mx-auto">{body}</p>
      <div className="flex gap-3 justify-center pt-2">
        {action && (
          <a
            href={action.href}
            className="px-5 py-2.5 rounded-xl text-sm font-bold bg-holder-accent text-holder-900 hover:bg-holder-accentBright transition"
          >
            {action.label}
          </a>
        )}
        <a
          href="/"
          className="px-5 py-2.5 rounded-xl text-sm font-medium border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
        >
          Browse all games
        </a>
      </div>
    </div>
  );
}
