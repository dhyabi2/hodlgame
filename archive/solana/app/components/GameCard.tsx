"use client";

import { tokenAvatarSvg } from "@/lib/avatar";
import { formatAmount } from "@/lib/amount";
import { shortAddress } from "@/lib/explorer";
import type { GameSummary } from "@/lib/games";

function fmtPrice(p: number): string {
  if (p < 0.000001) return p.toExponential(2);
  return p.toFixed(8).replace(/\.?0+$/, "");
}

function fmtSol(n: number): string {
  if (n >= 1000) return `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return n.toFixed(2);
}

/**
 * A directory tile in the pump.fun style: generated avatar, name/ticker, a
 * "hold rate" progress bar (the HoldFun answer to the bonding curve), and the
 * numbers that matter — price, market cap, staked. The risk state rides on the
 * tile rather than being buried on the game page.
 */
export function GameCard({ game }: { game: GameSummary }) {
  const name = game.name || shortAddress(game.mint);
  const symbol = game.symbol || "TOKEN";
  const risky =
    game.mintAuthorityRevoked === false || game.freezeAuthorityRevoked === false;
  const isNew =
    game.createdAt > 0 && Date.now() / 1000 - game.createdAt < 24 * 3600;

  // Hold rate: what fraction of the supply is currently staked.
  const holdRate =
    game.supply && !game.supply.isZero()
      ? Math.min(
          100,
          game.totalStaked.muln(10000).div(game.supply).toNumber() / 100
        )
      : 0;

  const avatar = tokenAvatarSvg(game.name || game.mint, game.symbol || "TOKEN");

  return (
    <a
      href={`/t/${game.mint}`}
      className="panel p-4 block transition hover:border-holder-accent/50 focus-visible:border-holder-accent"
    >
      <div className="flex items-center gap-3">
        <div
          className="w-12 h-12 rounded-xl shrink-0 border border-holder-700/80"
          style={{ backgroundImage: `url("${avatar}")`, backgroundSize: "cover" }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-ink-100 truncate leading-tight">
            {name}
          </p>
          <p className="text-xs text-ink-400 font-mono truncate">${symbol}</p>
        </div>
        {isNew ? (
          <span className="shrink-0 text-[11px] font-bold px-2 py-1 rounded-full bg-holder-accent text-holder-950">
            NEW
          </span>
        ) : (
          <span
            className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full border ${
              risky
                ? "border-holder-danger/50 text-holder-dangerBright"
                : "border-holder-accent/40 text-holder-accent"
            }`}
          >
            {risky ? "Risk" : "Locked"}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <p className="font-display text-xl font-bold text-ink-100 stat-number tabular-nums">
          {game.priceSol === null ? "—" : fmtPrice(game.priceSol)}
          {game.priceSol !== null && (
            <span className="text-xs font-normal text-ink-400 ml-1">SOL</span>
          )}
          {game.change24hPct !== null && (
            <span
              className={`ml-2 text-xs font-bold align-middle ${
                game.change24hPct >= 0
                  ? "text-holder-accent"
                  : "text-holder-dangerBright"
              }`}
            >
              {game.change24hPct >= 0 ? "+" : ""}
              {game.change24hPct.toFixed(1)}%
            </span>
          )}
        </p>
        <p className="text-xs text-ink-400 text-right">
          <span className="text-ink-500">MC</span>{" "}
          <span className="text-ink-200 font-semibold">
            {game.marketCapSol === null ? "—" : `${fmtSol(game.marketCapSol)} SOL`}
          </span>
        </p>
      </div>

      {/* Hold rate — the HoldFun bonding curve. */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-400">
            Hold rate
          </span>
          <span className="text-xs font-bold text-ink-100 stat-number tabular-nums">
            {holdRate.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-holder-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-holder-accent to-holder-accentBright"
            style={{ width: `${holdRate}%` }}
          />
        </div>
      </div>

      <p className="mt-3 text-xs text-ink-400 tabular-nums">
        Staked{" "}
        <span className="text-ink-200 font-semibold">
          {formatAmount(game.totalStaked, game.decimals, { min: 0, max: 0 })}
        </span>
      </p>
    </a>
  );
}
