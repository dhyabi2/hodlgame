"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
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
import confetti from "canvas-confetti";
import {
  findSwapPoolPDA,
  findSwapPoolHoldVault,
  formatAmount,
  getProgram,
  getProvider,
  quoteSwapOut,
} from "@/lib/program";
import { useToast } from "@/lib/toast";
import { playSwap } from "@/lib/sound";
import { friendlyError } from "@/lib/errors";

const SLIPPAGE_BPS = 100; // 1% tolerance
const HOLD_DECIMALS = 6;

type Direction = "sol-to-hold" | "hold-to-sol";

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
  const reduceMotion = useReducedMotion();

  const [direction, setDirection] = useState<Direction>("sol-to-hold");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [solReserve, setSolReserve] = useState<number | null>(null);
  const [holdReserve, setHoldReserve] = useState<number | null>(null);

  const [swapPoolPDA] = findSwapPoolPDA(mint);

  useEffect(() => {
    let cancelled = false;

    const fetchReserves = async () => {
      try {
        const info = await connection.getAccountInfo(swapPoolPDA);
        if (!info) {
          if (!cancelled) {
            setSolReserve(null);
            setHoldReserve(null);
          }
          return;
        }
        const rentExempt = await connection.getMinimumBalanceForRentExemption(
          info.data.length
        );
        const sol = Math.max(0, info.lamports - rentExempt) / LAMPORTS_PER_SOL;

        const holdVault = await findSwapPoolHoldVault(mint, swapPoolPDA);
        let hold = 0;
        try {
          const acc = await getAccount(connection, holdVault);
          hold = Number(acc.amount) / 10 ** HOLD_DECIMALS;
        } catch {
          hold = 0;
        }

        if (!cancelled) {
          setSolReserve(sol);
          setHoldReserve(hold);
        }
      } catch (err) {
        console.error("swap reserves fetch error", err);
      }
    };

    fetchReserves();
    const id = setInterval(fetchReserves, 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, swapPoolPDA, mint]);

  const amountNum = parseFloat(amount) || 0;
  const quote =
    solReserve !== null && holdReserve !== null && amountNum > 0
      ? direction === "sol-to-hold"
        ? quoteSwapOut(solReserve, holdReserve, amountNum)
        : quoteSwapOut(holdReserve, solReserve, amountNum)
      : 0;

  const inSymbol = direction === "sol-to-hold" ? "SOL" : "HOLD";
  const outSymbol = direction === "sol-to-hold" ? "HOLD" : "SOL";
  const price =
    solReserve && holdReserve
      ? direction === "sol-to-hold"
        ? holdReserve / solReserve
        : solReserve / holdReserve
      : null;

  const flip = () => {
    setDirection((d) => (d === "sol-to-hold" ? "hold-to-sol" : "sol-to-hold"));
    setAmount("");
  };

  const swap = async () => {
    if (!wallet.publicKey || amountNum <= 0) return;
    setLoading(true);
    try {
      const provider = getProvider(connection, wallet);
      const program = getProgram(provider);
      const holdVault = await findSwapPoolHoldVault(mint, swapPoolPDA);
      const userTokenAccount = await getAssociatedTokenAddress(
        mint,
        wallet.publicKey
      );

      if (direction === "sol-to-hold") {
        const solIn = new BN(Math.floor(amountNum * LAMPORTS_PER_SOL));
        const minHoldOut = new BN(
          Math.floor(quote * (1 - SLIPPAGE_BPS / 10000) * 10 ** HOLD_DECIMALS)
        );
        await program.methods
          .swapSolForHold(solIn, minHoldOut)
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
        const holdIn = new BN(Math.floor(amountNum * 10 ** HOLD_DECIMALS));
        const minSolOut = new BN(
          Math.floor(quote * (1 - SLIPPAGE_BPS / 10000) * LAMPORTS_PER_SOL)
        );
        await program.methods
          .swapHoldForSol(holdIn, minSolOut)
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
      onUpdate();
      playSwap();
      if (!reduceMotion) {
        confetti({
          particleCount: 60,
          spread: 60,
          startVelocity: 30,
          origin: { y: 0.6 },
          colors: ["#22d3ee", "#fbbf24"],
        });
      }
      toast.push(
        "success",
        "🔄 Swap complete",
        `${amountNum} ${inSymbol} → ~${quote.toFixed(4)} ${outSymbol}`
      );
    } catch (err) {
      console.error(err);
      toast.push("danger", "Swap failed", friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-holder-700 bg-holder-800/60 p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Get HOLD</h2>
        {price !== null && (
          <p className="text-xs text-slate-400">
            1 {inSymbol} ≈ {price.toFixed(inSymbol === "SOL" ? 2 : 8)} {outSymbol}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm text-slate-400">You pay</label>
        <div className="flex gap-2">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 rounded-xl bg-holder-900 border border-holder-700 px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-holder-accent"
          />
          <span className="flex items-center px-3 rounded-xl bg-holder-900 border border-holder-700 text-sm font-medium">
            {inSymbol}
          </span>
        </div>
      </div>

      <motion.button
        onClick={flip}
        whileHover={reduceMotion ? undefined : { scale: 1.1, rotate: 180 }}
        whileTap={reduceMotion ? undefined : { scale: 0.9 }}
        className="mx-auto flex items-center justify-center w-9 h-9 rounded-full border border-holder-700 bg-holder-900 hover:border-holder-accent transition text-lg"
        aria-label="Flip swap direction"
      >
        ⇅
      </motion.button>

      <div className="space-y-2">
        <label className="text-sm text-slate-400">You receive (est.)</label>
        <div className="flex gap-2">
          <div className="flex-1 rounded-xl bg-holder-900/50 border border-holder-700 px-4 py-3 text-slate-300">
            {quote > 0 ? quote.toFixed(6) : "0.00"}
          </div>
          <span className="flex items-center px-3 rounded-xl bg-holder-900 border border-holder-700 text-sm font-medium">
            {outSymbol}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          1% swap fee · 1% slippage tolerance
        </p>
      </div>

      <motion.button
        onClick={swap}
        disabled={
          loading || amountNum <= 0 || !wallet.publicKey || quote <= 0
        }
        whileHover={reduceMotion ? undefined : { scale: 1.02 }}
        whileTap={reduceMotion ? undefined : { scale: 0.97 }}
        className="w-full py-3 rounded-xl font-bold bg-holder-accent text-holder-900 hover:bg-cyan-300 transition disabled:opacity-50"
      >
        {loading ? "Swapping..." : !wallet.publicKey ? "Connect wallet" : "Swap"}
      </motion.button>
    </div>
  );
}
