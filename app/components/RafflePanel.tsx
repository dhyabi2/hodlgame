"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";
import {
  findRafflePoolPDA,
  findVaultStatePDA,
  findVaultTokenAccount,
  getProgram,
  getProvider,
  MAX_RAFFLE_ENTRANTS,
  PROGRAM_ID,
  RAFFLE_INTERVAL_SECS,
  RAFFLE_PRIZE_BPS,
} from "@/lib/program";
import { useToast } from "@/lib/toast";
import { playRaffleWin } from "@/lib/sound";
import idl from "@/lib/idl.json";

const HOLD_DECIMALS = 6;

function formatCountdown(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${m}m ${s}s`;
}

export function RafflePanel({
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

  const [lastDraw, setLastDraw] = useState<number | null>(null);
  const [round, setRound] = useState<number | null>(null);
  const [jackpot, setJackpot] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(false);

  const [rafflePoolPDA] = findRafflePoolPDA(mint);
  const [vaultPDA] = findVaultStatePDA(mint);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program<any>(idl as any, PROGRAM_ID, provider);

    const fetchState = async () => {
      try {
        const raffle = await (program.account as any).rafflePool.fetchNullable(
          rafflePoolPDA
        );
        if (raffle && !cancelled) {
          setLastDraw(Number(raffle.lastDrawTime));
          setRound(Number(raffle.round));
        }
        const vaultAta = await findVaultTokenAccount(mint, vaultPDA);
        try {
          const acc = await getAccount(connection, vaultAta);
          if (!cancelled) setJackpot(Number(acc.amount) / 10 ** HOLD_DECIMALS);
        } catch {
          if (!cancelled) setJackpot(0);
        }
      } catch (err) {
        console.error("raffle state fetch error", err);
      }
    };

    fetchState();
    const id = setInterval(fetchState, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, rafflePoolPDA, vaultPDA, mint]);

  const nextDrawAt = lastDraw !== null ? lastDraw + RAFFLE_INTERVAL_SECS : null;
  const secondsLeft = nextDrawAt !== null ? Math.max(0, nextDrawAt - now) : null;
  const ready = secondsLeft === 0;
  const prizeEstimate = (jackpot * RAFFLE_PRIZE_BPS) / 10000;

  const draw = async () => {
    if (!wallet.publicKey || !ready) return;
    setLoading(true);
    try {
      const provider = getProvider(connection, wallet);
      const program = getProgram(provider);

      const stakeAccounts = await (program.account as any).stakeAccount.all();
      const eligible = stakeAccounts
        .filter((a: any) => a.account.amount.gtn(0))
        .sort((a: any, b: any) =>
          a.account.points.lt(b.account.points) ? 1 : -1
        )
        .slice(0, MAX_RAFFLE_ENTRANTS);

      if (eligible.length === 0) {
        toast.push(
          "danger",
          "No entrants",
          "Nobody is staked yet — the raffle needs stakers."
        );
        return;
      }

      const remainingAccounts: {
        pubkey: PublicKey;
        isWritable: boolean;
        isSigner: boolean;
      }[] = [];
      for (const entry of eligible) {
        const owner = entry.account.owner as PublicKey;
        const ata = await getAssociatedTokenAddress(mint, owner);
        remainingAccounts.push({
          pubkey: entry.publicKey,
          isWritable: false,
          isSigner: false,
        });
        remainingAccounts.push({ pubkey: ata, isWritable: true, isSigner: false });
      }

      const vaultAta = await findVaultTokenAccount(mint, vaultPDA);

      await program.methods
        .drawRaffle()
        .accounts({
          vaultState: vaultPDA,
          rafflePool: rafflePoolPDA,
          mint,
          vaultTokenAccount: vaultAta,
          caller: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .remainingAccounts(remainingAccounts)
        .rpc();

      onUpdate();
      playRaffleWin();
      if (!reduceMotion) {
        confetti({
          particleCount: 150,
          spread: 100,
          startVelocity: 45,
          origin: { y: 0.5 },
          colors: ["#fbbf24", "#22d3ee", "#34d399"],
        });
      }
      toast.push(
        "success",
        "🎉 Raffle drawn!",
        `${eligible.length} entrants — check the live feed for the winner.`
      );
    } catch (err) {
      console.error(err);
      toast.push("danger", "Draw failed", (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-holder-jackpot/40 bg-gradient-to-b from-holder-800/60 to-holder-900/40 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">💎 Diamond Raffle</h2>
        {round !== null && (
          <span className="text-xs text-slate-500">Round #{round}</span>
        )}
      </div>

      <div className="rounded-xl bg-holder-900/50 p-4 text-center">
        <p className="text-xs text-slate-400 uppercase tracking-wider">
          Prize pool
        </p>
        <p className="text-2xl font-bold text-holder-jackpot mt-1">
          {prizeEstimate.toFixed(2)} HOLD
        </p>
        <p className="text-xs text-slate-500 mt-1">10% of the jackpot vault</p>
      </div>

      <div className="text-center">
        {secondsLeft !== null && secondsLeft > 0 ? (
          <p className="text-sm text-slate-400">
            Next draw in{" "}
            <span className="font-mono text-white">
              {formatCountdown(secondsLeft)}
            </span>
          </p>
        ) : (
          <p className="text-sm text-holder-success font-medium">
            Ready to draw!
          </p>
        )}
      </div>

      <p className="text-xs text-slate-500 text-center">
        Odds weighted by Diamond Hands score (stake × time) — patience beats
        wallet size.
      </p>

      <button
        onClick={draw}
        disabled={loading || !ready || !wallet.publicKey}
        className="w-full py-3 rounded-xl font-bold bg-holder-jackpot text-holder-900 hover:bg-amber-300 transition disabled:opacity-50"
      >
        {loading
          ? "Drawing..."
          : !wallet.publicKey
          ? "Connect wallet"
          : "Draw Raffle"}
      </button>
    </div>
  );
}
