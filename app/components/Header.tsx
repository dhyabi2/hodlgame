"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useBalances } from "@/lib/balances";
import { useOptionalMint } from "@/lib/mint";
import { formatAmount } from "@/lib/amount";
import { NETWORK_LABEL, IS_MAINNET } from "@/lib/explorer";
import { SoundToggle } from "./SoundToggle";

/**
 * Sticky header. The wallet button used to scroll out of view on the first
 * flick, and the HOLD balance was rendered in the page *footer* — two screens
 * below the inputs that spend it. Both now stay on screen permanently.
 */
export function Header() {
  const wallet = useWallet();
  const balances = useBalances();
  const game = useOptionalMint();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 -mx-4 sm:-mx-6 px-4 sm:px-6 pt-[env(safe-area-inset-top)] transition-colors ${
        scrolled
          ? "bg-holder-950/85 backdrop-blur-md border-b border-holder-700/50"
          : "border-b border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 py-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <a
            href="/"
            className="font-display text-2xl sm:text-3xl font-bold holdfun-gradient whitespace-nowrap"
          >
            <span aria-hidden className="mr-1.5">
              🎉
            </span>
            HoldFun
          </a>
          {game?.name && (
            <span className="hidden sm:inline text-sm text-ink-300 truncate max-w-[14rem]">
              / {game.name}
            </span>
          )}
          <span
            className={`hidden sm:inline text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
              IS_MAINNET
                ? "border-holder-success/50 text-holder-success"
                : "border-holder-violet/50 text-holder-violet"
            }`}
            title={
              IS_MAINNET
                ? "Live network"
                : "Play money — these tokens have no value"
            }
          >
            {NETWORK_LABEL}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {wallet.publicKey && (
            <div className="hidden md:flex items-center gap-3 mr-1 px-3 py-1.5 rounded-xl bg-holder-900/70 border border-holder-700/60">
              {game && (
                <>
                  <Balance
                    label={game.symbol}
                    value={
                      balances.hold === null
                        ? null
                        : formatAmount(balances.hold, game.decimals)
                    }
                  />
                  <span className="w-px h-6 bg-holder-700" aria-hidden />
                </>
              )}
              <Balance
                label="SOL"
                value={balances.sol === null ? null : balances.sol.toFixed(3)}
              />
            </div>
          )}
          <a
            href="/create"
            className="hidden sm:inline-flex items-center h-10 px-4 rounded-lg font-bold bg-holder-accent text-holder-950 hover:bg-holder-accentBright transition"
          >
            Start a coin
          </a>
          <SoundToggle />
          <WalletMultiButton className="!h-10 !rounded-lg !bg-holder-accent !text-holder-950 !font-bold hover:!bg-holder-accentBright" />
        </div>
      </div>

      {/* Balances move under the title on small screens rather than disappearing. */}
      {wallet.publicKey && (
        <div className="md:hidden max-w-6xl mx-auto flex items-center gap-4 pb-2 text-xs">
          {game && (
            <Balance
              label={game.symbol}
              value={
                balances.hold === null
                  ? null
                  : formatAmount(balances.hold, game.decimals)
              }
            />
          )}
          <Balance
            label="SOL"
            value={balances.sol === null ? null : balances.sol.toFixed(3)}
          />
          <span className="ml-auto text-[11px] text-ink-400">{NETWORK_LABEL}</span>
        </div>
      )}
    </header>
  );
}

function Balance({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="text-xs whitespace-nowrap">
      <span className="text-ink-400">{label} </span>
      <span className="stat-number tabular-nums text-ink-100 font-semibold">
        {value ?? "—"}
      </span>
    </p>
  );
}
