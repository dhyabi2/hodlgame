"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import {
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";
import {
  getProgram,
  getProvider,
  findVaultStatePDA,
  findStakeVaultPDA,
  findStakeAccountPDA,
  formatAmount,
} from "@/lib/program";
import { useToast } from "@/lib/toast";
import { playStake, playTax, playClaim } from "@/lib/sound";

export function StakePanel({
  mint,
  onUpdate,
  onPosition,
}: {
  mint: PublicKey;
  onUpdate: () => void;
  onPosition?: (acc: { amount: BN; points: BN } | null) => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [amount, setAmount] = useState("");
  const [staked, setStaked] = useState<string>("0");
  const [pending, setPending] = useState<string>("0");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [shake, setShake] = useState(false);

  const [vaultPDA] = findVaultStatePDA(mint);
  const [stakeVaultPDA] = findStakeVaultPDA(mint);

  useEffect(() => {
    if (!wallet.publicKey) return;
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [wallet.publicKey]);

  const refresh = async () => {
    if (!wallet.publicKey) return;
    try {
      const provider = getProvider(connection, wallet);
      const program = getProgram(provider);
      const [stakePDA] = findStakeAccountPDA(vaultPDA, wallet.publicKey);
      const acc = await (program.account as any).stakeAccount
        .fetchNullable(stakePDA)
        .catch(() => null);
      if (acc) {
        setStaked(formatAmount(acc.amount));
        onPosition?.({ amount: acc.amount, points: acc.points });

        const vault = await (program.account as any).vaultState.fetch(vaultPDA);
        const now = Math.floor(Date.now() / 1000);
        const elapsed = Math.max(0, now - Number(acc.lastUpdateTime));
        const points = new BN(acc.points.toString()).add(
          new BN(acc.amount.toString()).mul(new BN(elapsed))
        );
        const reward = points
          .mul(new BN(vault.rewardPerPoint.toString()))
          .div(new BN("1000000000000"))
          .sub(new BN(acc.rewardDebt.toString()));
        setPending(formatAmount(reward.gte(new BN(0)) ? reward : new BN(0)));
      } else {
        setStaked("0");
        setPending("0");
        onPosition?.(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fireConfetti = () => {
    if (reduceMotion) return;
    confetti({
      particleCount: 90,
      spread: 75,
      startVelocity: 40,
      origin: { y: 0.6 },
      colors: ["#22d3ee", "#34d399", "#fbbf24"],
    });
  };

  const fireShake = () => {
    if (reduceMotion) return;
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const ensureAta = async (owner: PublicKey) => {
    if (!wallet.publicKey) throw new Error("Not connected");
    const ata = await getAssociatedTokenAddress(mint, owner);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          ata,
          owner,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const sig = await wallet.sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
    }
    return ata;
  };

  const stake = async () => {
    if (!wallet.publicKey || !amount) return;
    setLoading(true);
    try {
      const provider = getProvider(connection, wallet);
      const program = getProgram(provider);
      const lamports = new BN(parseFloat(amount) * 1e6);

      const userAta = await ensureAta(wallet.publicKey);
      const [stakePDA] = findStakeAccountPDA(vaultPDA, wallet.publicKey);
      const stakeAta = await getAssociatedTokenAddress(mint, stakeVaultPDA, true);

      await program.methods
        .stake(lamports)
        .accounts({
          vaultState: vaultPDA,
          stakeVault: stakeVaultPDA,
          mint,
          stakeAccount: stakePDA,
          stakeTokenAccount: stakeAta,
          userTokenAccount: userAta,
          user: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setAmount("");
      await refresh();
      onUpdate();
      playStake();
      fireConfetti();
      toast.push("success", "💎 Diamond hands!", `Staked ${amount} HOLD.`);
    } catch (err) {
      console.error(err);
      toast.push("danger", "Stake failed", (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const unstake = async () => {
    if (!wallet.publicKey || !amount) return;
    setLoading(true);
    try {
      const provider = getProvider(connection, wallet);
      const program = getProgram(provider);
      const lamports = new BN(parseFloat(amount) * 1e6);

      const [stakePDA] = findStakeAccountPDA(vaultPDA, wallet.publicKey);
      const stakeAta = await getAssociatedTokenAddress(mint, stakeVaultPDA, true);
      const vaultAta = await getAssociatedTokenAddress(mint, vaultPDA, true);
      const userAta = await ensureAta(wallet.publicKey);

      await program.methods
        .unstake(lamports)
        .accounts({
          vaultState: vaultPDA,
          stakeVault: stakeVaultPDA,
          mint,
          stakeAccount: stakePDA,
          stakeTokenAccount: stakeAta,
          vaultTokenAccount: vaultAta,
          userTokenAccount: userAta,
          user: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      const taxAmount = formatAmount(
        new BN(parseFloat(amount) * 1e6 * 0.2)
      );
      setAmount("");
      await refresh();
      onUpdate();
      playTax();
      fireShake();
      toast.push(
        "danger",
        "🧻 Paper hands!",
        `Paid ${taxAmount} HOLD tax into the jackpot vault.`
      );
    } catch (err) {
      console.error(err);
      toast.push("danger", "Unstake failed", (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const claim = async () => {
    if (!wallet.publicKey) return;
    setLoading(true);
    try {
      const provider = getProvider(connection, wallet);
      const program = getProgram(provider);
      const [stakePDA] = findStakeAccountPDA(vaultPDA, wallet.publicKey);
      const vaultAta = await getAssociatedTokenAddress(mint, vaultPDA, true);
      const userAta = await ensureAta(wallet.publicKey);

      await program.methods
        .claimRebate()
        .accounts({
          vaultState: vaultPDA,
          mint,
          stakeAccount: stakePDA,
          vaultTokenAccount: vaultAta,
          userTokenAccount: userAta,
          user: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      await refresh();
      onUpdate();
      playClaim();
      fireConfetti();
      toast.push("success", "✨ Rebate claimed!", `Collected ${pending} HOLD.`);
    } catch (err) {
      console.error(err);
      toast.push("danger", "Claim failed", (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const execute = mode === "stake" ? stake : unstake;

  return (
    <div
      className={`rounded-2xl border border-holder-700 bg-holder-800/60 p-6 space-y-6 ${
        shake ? "animate-shake" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Your Position</h2>
        <div className="flex bg-holder-900 rounded-lg p-1">
          <button
            onClick={() => setMode("stake")}
            className={`px-4 py-1 rounded-md text-sm font-medium transition ${
              mode === "stake"
                ? "bg-holder-accent text-holder-900"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Stake
          </button>
          <button
            onClick={() => setMode("unstake")}
            className={`px-4 py-1 rounded-md text-sm font-medium transition ${
              mode === "unstake"
                ? "bg-holder-danger text-white"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Unstake
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl bg-holder-900/50 p-4">
          <p className="text-xs text-slate-400 uppercase">Staked</p>
          <p className="text-xl font-bold">{staked} HOLD</p>
        </div>
        <div className="rounded-xl bg-holder-900/50 p-4">
          <p className="text-xs text-slate-400 uppercase">Pending Rebate</p>
          <p className="text-xl font-bold text-holder-success">{pending} HOLD</p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-slate-400">
          {mode === "stake" ? "Amount to stake" : "Amount to unstake"}
        </label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="w-full rounded-xl bg-holder-900 border border-holder-700 px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-holder-accent"
        />
        {mode === "unstake" && amount && (
          <p className="text-sm text-holder-danger">
            You will receive {formatAmount(new BN(parseFloat(amount) * 1e6 * 0.8))} HOLD
            (20% tax = {formatAmount(new BN(parseFloat(amount) * 1e6 * 0.2))} HOLD)
          </p>
        )}
      </div>

      <button
        onClick={execute}
        disabled={loading || !amount}
        className={`w-full py-3 rounded-xl font-bold transition ${
          mode === "stake"
            ? "bg-holder-accent text-holder-900 hover:bg-cyan-300"
            : "bg-holder-danger text-white hover:bg-rose-500"
        } disabled:opacity-50`}
      >
        {loading ? "Processing..." : mode === "stake" ? "Stake" : "Unstake"}
      </button>

      <button
        onClick={claim}
        disabled={loading}
        className="w-full py-3 rounded-xl font-bold border border-holder-success text-holder-success hover:bg-holder-success/10 transition disabled:opacity-50"
      >
        Claim Rebate
      </button>
    </div>
  );
}
