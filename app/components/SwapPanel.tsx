"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { motion, useReducedMotion } from "framer-motion";
import {
  findSwapPoolPDA,
  findSwapPoolHoldVault,
  getProgram,
  getProvider,
  quoteSwapOut,
} from "@/lib/program";
import { formatAmount, parseAmount, toDecimalString } from "@/lib/amount";
import { useToast } from "@/lib/toast";
import { playSwap, haptic } from "@/lib/sound";
import { friendlyError } from "@/lib/errors";
import { markActedToday } from "@/lib/daily";
import { useBalances, SOL_FEE_BUFFER_LAMPORTS } from "@/lib/balances";
import { useMint } from "@/lib/mint";
import { usePoll } from "@/lib/usePoll";
import { AmountField, validateAmount } from "./AmountField";
import { LoadError, SectionTitle, Skeleton } from "./ui";

const SOL_DECIMALS = 9;
const HIGH_IMPACT_PCT = 5;
const BUY_PRESETS = [0.1, 0.5, 1, 2] as const; // SOL
const SELL_PRESETS = [25, 50, 100] as const; // %

type Tab = "buy" | "sell";

export function SwapPanel({
  mint,
  onUpdate,
}: {
  mint: PublicKey;
  onUpdate: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const balances = useBalances();
  const { symbol: tokenSymbol, decimals: tokenDecimals } = useMint();
  const reduceMotion = useReducedMotion();

  const [tab, setTab] = useState<Tab>("buy");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const [swapPoolPDA] = findSwapPoolPDA(mint);

  const { data: reserves, status, refetch } = usePoll(
    async () => {
      const info = await connection.getAccountInfo(swapPoolPDA);
      if (!info) return { exists: false as const, sol: 0, hold: 0 };
      const rentExempt = await connection.getMinimumBalanceForRentExemption(
        info.data.length
      );
      const sol = Math.max(0, info.lamports - rentExempt) / LAMPORTS_PER_SOL;
      const holdVault = await findSwapPoolHoldVault(mint, swapPoolPDA);
      const hold = await getAccount(connection, holdVault)
        .then((acc) => Number(acc.amount) / 10 ** tokenDecimals)
        .catch(() => 0);
      return { exists: true as const, sol, hold };
    },
    { intervalMs: 20000, staggerMs: 800 },
    [connection, swapPoolPDA.toBase58()]
  );

  const isBuy = tab === "buy";
  const inSymbol = isBuy ? "SOL" : tokenSymbol;
  const outSymbol = isBuy ? tokenSymbol : "SOL";
  const inDecimals = isBuy ? SOL_DECIMALS : tokenDecimals;
  const outDecimals = isBuy ? tokenDecimals : SOL_DECIMALS;

  const inBalance = isBuy ? balances.lamports : balances.hold;
  const spendable = isBuy
    ? balances.lamports
      ? BN.max(balances.lamports.sub(SOL_FEE_BUFFER_LAMPORTS), new BN(0))
      : null
    : balances.hold;

  const validation = useMemo(
    () =>
      validateAmount(amount, {
        balance: spendable,
        decimals: inDecimals,
        symbol: inSymbol,
        minLabel: isBuy ? "available after fees" : "in your wallet",
      }),
    [amount, spendable, inDecimals, inSymbol, isBuy]
  );

  const amountNum = useMemo(() => {
    const parsed = parseAmount(amount, inDecimals);
    if (!parsed) return 0;
    return Number(toDecimalString(parsed, inDecimals));
  }, [amount, inDecimals]);

  const poolReady = status === "ready" && reserves?.exists && reserves.hold > 0;
  const reserveIn = poolReady ? (isBuy ? reserves!.sol : reserves!.hold) : 0;
  const reserveOut = poolReady ? (isBuy ? reserves!.hold : reserves!.sol) : 0;

  const quote =
    poolReady && amountNum > 0 ? quoteSwapOut(reserveIn, reserveOut, amountNum) : 0;

  const spotPrice = poolReady && reserveIn > 0 ? reserveOut / reserveIn : null;
  const priceImpactPct =
    spotPrice && quote > 0 && amountNum > 0
      ? Math.max(0, (1 - quote / (amountNum * spotPrice)) * 100)
      : 0;
  const minReceived = quote * 0.99; // 1% slippage tolerance, fixed
  const highImpact = priceImpactPct >= HIGH_IMPACT_PCT;
  const drainsPool = quote > 0 && quote >= reserveOut * 0.9;

  const setBuyPreset = (sol: number) => setAmount(String(sol));
  const setSellPreset = (pct: number) => {
    if (!balances.hold) return;
    const part = pct === 100 ? balances.hold : balances.hold.muln(pct).divn(100);
    setAmount(toDecimalString(part, tokenDecimals));
  };
  const setMax = () => {
    if (!spendable) return;
    setAmount(toDecimalString(spendable, inDecimals));
  };

  const swap = async () => {
    if (!wallet.publicKey || amountNum <= 0 || validation.error) return;
    const submitted = `${amountNum} ${inSymbol}`;
    setLoading(true);
    try {
      const program = getProgram(getProvider(connection, wallet));
      const holdVault = await findSwapPoolHoldVault(mint, swapPoolPDA);
      const userTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey);

      let signature: string;
      if (isBuy) {
        signature = await program.methods
          .swapSolForHold(
            new BN(Math.floor(amountNum * LAMPORTS_PER_SOL)),
            new BN(Math.floor(minReceived * 10 ** tokenDecimals))
          )
          .accounts({
            mint,
            swapPool: swapPoolPDA,
            holdVault,
            userTokenAccount,
            user: wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          } as any)
          .rpc();
      } else {
        signature = await program.methods
          .swapHoldForSol(
            new BN(Math.floor(amountNum * 10 ** tokenDecimals)),
            new BN(Math.floor(minReceived * LAMPORTS_PER_SOL))
          )
          .accounts({
            mint,
            swapPool: swapPoolPDA,
            holdVault,
            userTokenAccount,
            user: wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc();
      }

      setAmount("");
      refetch();
      balances.refetch();
      onUpdate();
      markActedToday();
      playSwap();
      haptic(20);
      toast.show({
        kind: "success",
        title: isBuy ? "🟢 Buy complete" : "🔴 Sell complete",
        detail: `${submitted} → ~${quote.toFixed(4)} ${outSymbol}`,
        signature,
      });
    } catch (err) {
      console.error(err);
      toast.show({
        kind: "danger",
        title: isBuy ? "Buy failed" : "Sell failed",
        detail: friendlyError(err),
        action: { label: "Try again", onClick: swap },
      });
    } finally {
      setLoading(false);
    }
  };

  const disabledReason = (() => {
    if (!wallet.publicKey) return "Connect a wallet to trade.";
    if (status === "ready" && !reserves?.exists)
      return "The swap pool hasn't been seeded yet.";
    if (amountNum <= 0) return `Enter an amount to ${isBuy ? "buy" : "sell"}.`;
    if (quote <= 0) return "Not enough liquidity for this trade.";
    return null;
  })();

  return (
    <div id="swap" className="panel p-5 sm:p-6 space-y-5 scroll-mt-24">
      <SectionTitle
        right={
          spotPrice !== null ? (
            <p className="text-xs text-ink-300 tabular-nums">
              1 {tokenSymbol} ≈{" "}
              {spotPrice < 0.01 ? spotPrice.toFixed(8) : spotPrice.toFixed(4)} SOL
            </p>
          ) : status === "loading" ? (
            <Skeleton className="h-4 w-28" />
          ) : null
        }
      >
        Trade {tokenSymbol}
      </SectionTitle>

      {/* Buy / Sell tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-holder-900/70 p-1">
        {(["buy", "sell"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setAmount("");
            }}
            className={`min-h-[40px] rounded-lg font-bold transition ${
              tab === t
                ? t === "buy"
                  ? "bg-holder-accent text-holder-950"
                  : "bg-holder-danger text-white"
                : "text-ink-300 hover:text-white"
            }`}
          >
            {t === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {status === "error" ? (
        <LoadError what="the swap pool" onRetry={refetch} />
      ) : status === "ready" && !reserves?.exists ? (
        <div className="rounded-xl border border-holder-700 bg-holder-900/60 p-5 text-center space-y-2">
          <p className="text-3xl" aria-hidden>
            🏗️
          </p>
          <p className="text-sm text-ink-100 font-medium">
            The swap pool isn&apos;t live yet.
          </p>
          <p className="text-xs text-ink-300">
            Once liquidity is seeded you&apos;ll be able to buy {tokenSymbol} right
            here. Staking still works in the meantime.
          </p>
        </div>
      ) : (
        <>
          <AmountField
            label={isBuy ? "You pay" : "You sell"}
            value={amount}
            onChange={setAmount}
            symbol={inSymbol}
            decimals={inDecimals}
            balance={inBalance}
            spendable={spendable}
            balanceLabel="Wallet"
            error={validation.error}
          />

          {/* Presets: one click sets the amount, the button below executes. */}
          <div className="flex gap-2">
            {isBuy
              ? BUY_PRESETS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setBuyPreset(s)}
                    className="flex-1 min-h-[36px] rounded-lg border border-holder-700 text-xs font-medium text-ink-300 hover:border-holder-accent hover:text-holder-accent transition"
                  >
                    {s} SOL
                  </button>
                ))
              : SELL_PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setSellPreset(p)}
                    className="flex-1 min-h-[36px] rounded-lg border border-holder-700 text-xs font-medium text-ink-300 hover:border-holder-danger hover:text-holder-dangerBright transition"
                  >
                    {p}%
                  </button>
                ))}
            <button
              onClick={setMax}
              className="flex-1 min-h-[36px] rounded-lg border border-holder-accent/60 bg-holder-accent/10 text-xs font-bold text-holder-accent hover:bg-holder-accent/20 transition"
            >
              MAX
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-300">You receive</p>
            <div className="flex items-stretch rounded-xl border border-holder-700 bg-holder-900/50">
              <div className="flex-1 min-w-0 px-4 py-3 text-lg stat-number text-ink-100 truncate">
                {quote > 0 ? quote.toFixed(outSymbol === "SOL" ? 6 : 4) : "0.00"}
              </div>
              <span className="flex items-center px-3 text-sm font-semibold text-ink-200 border-l border-holder-700">
                {outSymbol}
              </span>
            </div>
          </div>

          {(highImpact || drainsPool) && (
            <p className="text-xs text-holder-dangerBright text-center" role="alert">
              ⚠ This trade is large for the pool — you&apos;ll get a bad rate.
            </p>
          )}

          <motion.button
            type="button"
            onClick={swap}
            disabled={loading || !wallet.publicKey || amountNum <= 0 || quote <= 0 || !!validation.error}
            whileHover={reduceMotion ? undefined : { scale: 1.01 }}
            whileTap={reduceMotion ? undefined : { scale: 0.99 }}
            className={`w-full min-h-[52px] py-3 px-4 rounded-xl font-bold transition flex items-center justify-center gap-2 disabled:opacity-45 disabled:cursor-not-allowed ${
              isBuy
                ? "bg-holder-accent text-holder-950 hover:bg-holder-accentBright shadow-glow-accent"
                : "bg-holder-danger text-white hover:bg-holder-dangerBright"
            }`}
          >
            {loading
              ? isBuy
                ? "Buying…"
                : "Selling…"
              : wallet.publicKey
              ? `${isBuy ? "Buy" : "Sell"} ${tokenSymbol}`
              : "Connect wallet"}
          </motion.button>

          {!wallet.publicKey && (
            <p className="text-xs text-ink-400 text-center">{disabledReason}</p>
          )}
        </>
      )}

      {poolReady && (
        <p className="text-xs text-ink-400 text-center tabular-nums">
          Pool: {reserves!.sol.toFixed(3)} SOL ·{" "}
          {formatAmount(new BN(Math.floor(reserves!.hold * 10 ** tokenDecimals)), tokenDecimals)}{" "}
          {tokenSymbol}
        </p>
      )}
    </div>
  );
}
