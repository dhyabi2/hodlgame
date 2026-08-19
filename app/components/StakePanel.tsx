"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "@/lib/program";
import { bpsOf, formatAmount } from "@/lib/amount";
import { useToast } from "@/lib/toast";
import { playStake, playTax, playClaim, haptic } from "@/lib/sound";
import { friendlyError } from "@/lib/errors";
import { markActedToday } from "@/lib/daily";
import { useBalances } from "@/lib/balances";
import { useMint } from "@/lib/mint";
import { usePoll } from "@/lib/usePoll";
import { AmountField, validateAmount } from "./AmountField";
import { Modal } from "./Modal";
import { ActionButton, ReceiptRow, SectionTitle, Skeleton } from "./ui";

const TAX_BPS = 2000;
const BURN_BPS = 500;
const REBATE_BPS = 1500;

interface Position {
  amount: BN;
  points: BN;
  pending: BN;
}

export function StakePanel({
  mint,
  onUpdate,
  onPosition,
  onNeedHold,
}: {
  mint: PublicKey;
  onUpdate: () => void;
  onPosition?: (acc: { amount: BN; points: BN } | null) => void;
  /** Called when the user has nothing to stake — routes them to the swap panel. */
  onNeedHold?: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const balances = useBalances();
  const { symbol, decimals } = useMint();
  const reduceMotion = useReducedMotion();

  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [shake, setShake] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [vaultPDA] = findVaultStatePDA(mint);
  const [stakeVaultPDA] = findStakeVaultPDA(mint);
  const owner = wallet.publicKey;

  const { data: position, status, refetch } = usePoll<Position | null>(
    async () => {
      if (!owner || !wallet.signTransaction) return null;
      const program = getProgram(getProvider(connection, wallet));
      const [stakePDA] = findStakeAccountPDA(vaultPDA, owner);
      const acc = await (program.account as any).stakeAccount.fetchNullable(
        stakePDA
      );
      if (!acc) return null;

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

      return {
        amount: acc.amount as BN,
        points: acc.points as BN,
        pending: reward.isNeg() ? new BN(0) : reward,
      };
    },
    { intervalMs: 15000, enabled: !!owner, staggerMs: 400 },
    [connection, owner?.toBase58()]
  );

  useEffect(() => {
    if (status !== "ready") return;
    onPosition?.(position ? { amount: position.amount, points: position.points } : null);
  }, [position, status, onPosition]);

  const staked = position?.amount ?? new BN(0);
  const pending = position?.pending ?? new BN(0);
  const known = status === "ready";

  // The pool the current mode spends from: wallet balance to stake, staked
  // balance to unstake.
  const spendable = mode === "stake" ? balances.hold : known ? staked : null;

  const validation = useMemo(
    () =>
      validateAmount(amount, {
        balance: spendable,
        symbol,
        minLabel: mode === "stake" ? "in your wallet" : "staked",
      }),
    [amount, spendable, mode]
  );

  const parsed = validation.value;
  const tax = parsed ? bpsOf(parsed, TAX_BPS) : new BN(0);
  const burn = parsed ? bpsOf(parsed, BURN_BPS) : new BN(0);
  const toVault = parsed ? bpsOf(parsed, REBATE_BPS) : new BN(0);
  const received = parsed ? parsed.sub(tax) : new BN(0);

  const hasNoHold = balances.hold !== null && balances.hold.isZero();

  const fireConfetti = useCallback(() => {
    if (reduceMotion) return;
    confetti({
      particleCount: 90,
      spread: 75,
      startVelocity: 40,
      origin: { y: 0.6 },
      colors: ["#22d3ee", "#34d399", "#fbbf24"],
    });
  }, [reduceMotion]);

  const afterWrite = useCallback(() => {
    setAmount("");
    refetch();
    balances.refetch();
    onUpdate();
    markActedToday();
  }, [refetch, balances, onUpdate]);

  const ensureAta = async (target: PublicKey) => {
    if (!owner) throw new Error("Wallet not connected");
    const ata = await getAssociatedTokenAddress(mint, target);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          owner,
          ata,
          target,
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
    if (!owner || !parsed || validation.error) return;
    // Captured before the write, because refreshing zeroes the input.
    const submitted = formatAmount(parsed, decimals);
    setLoading(true);
    try {
      const program = getProgram(getProvider(connection, wallet));
      const userAta = await ensureAta(owner);
      const [stakePDA] = findStakeAccountPDA(vaultPDA, owner);
      const stakeAta = await getAssociatedTokenAddress(mint, stakeVaultPDA, true);

      const signature = await program.methods
        .stake(parsed)
        .accounts({
          vaultState: vaultPDA,
          stakeVault: stakeVaultPDA,
          mint,
          stakeAccount: stakePDA,
          stakeTokenAccount: stakeAta,
          userTokenAccount: userAta,
          user: owner,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();

      afterWrite();
      playStake();
      haptic(20);
      fireConfetti();
      toast.show({
        kind: "success",
        title: "💎 Diamond hands!",
        detail: `Staked ${submitted} ${symbol}. The clock starts now.`,
        signature,
      });
    } catch (err) {
      console.error(err);
      toast.show({
        kind: "danger",
        title: "Stake failed",
        detail: friendlyError(err),
        action: { label: "Try again", onClick: stake },
      });
    } finally {
      setLoading(false);
    }
  };

  const unstake = async () => {
    if (!owner || !parsed || validation.error) return;
    setConfirming(false);
    const paidToVault = formatAmount(toVault, decimals);
    const burned = formatAmount(burn, decimals);
    const kept = formatAmount(received, decimals);
    setLoading(true);
    try {
      const program = getProgram(getProvider(connection, wallet));
      const [stakePDA] = findStakeAccountPDA(vaultPDA, owner);
      const stakeAta = await getAssociatedTokenAddress(mint, stakeVaultPDA, true);
      const vaultAta = await getAssociatedTokenAddress(mint, vaultPDA, true);
      const userAta = await ensureAta(owner);

      const signature = await program.methods
        .unstake(parsed)
        .accounts({
          vaultState: vaultPDA,
          stakeVault: stakeVaultPDA,
          mint,
          stakeAccount: stakePDA,
          stakeTokenAccount: stakeAta,
          vaultTokenAccount: vaultAta,
          userTokenAccount: userAta,
          user: owner,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();

      afterWrite();
      playTax();
      haptic([30, 50, 30]);
      if (!reduceMotion) {
        setShake(true);
        setTimeout(() => setShake(false), 450);
      }
      toast.show({
        kind: "danger",
        title: "🧻 Paper hands!",
        detail: `You kept ${kept} ${symbol}. ${paidToVault} went to the jackpot and 🔥 ${burned} is gone forever.`,
        signature,
      });
    } catch (err) {
      console.error(err);
      toast.show({
        kind: "danger",
        title: "Unstake failed",
        detail: friendlyError(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const claim = async () => {
    if (!owner || pending.isZero()) return;
    // The old code read `pending` *after* refresh() had already zeroed it, so
    // this toast always said "Collected 0.0000 HOLD".
    const claimed = formatAmount(pending, decimals);
    setLoading(true);
    try {
      const program = getProgram(getProvider(connection, wallet));
      const [stakePDA] = findStakeAccountPDA(vaultPDA, owner);
      const vaultAta = await getAssociatedTokenAddress(mint, vaultPDA, true);
      const userAta = await ensureAta(owner);

      const signature = await program.methods
        .claimRebate()
        .accounts({
          vaultState: vaultPDA,
          mint,
          stakeAccount: stakePDA,
          vaultTokenAccount: vaultAta,
          userTokenAccount: userAta,
          user: owner,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();

      afterWrite();
      playClaim();
      haptic(20);
      fireConfetti();
      toast.show({
        kind: "success",
        title: "✨ Rebate claimed!",
        detail: `Collected ${claimed} ${symbol}, paid for by everyone who folded.`,
        signature,
      });
    } catch (err) {
      console.error(err);
      toast.show({
        kind: "danger",
        title: "Claim failed",
        detail: friendlyError(err),
        action: { label: "Try again", onClick: claim },
      });
    } finally {
      setLoading(false);
    }
  };

  const submitDisabled = loading || !parsed || !!validation.error || parsed.isZero();
  const disabledReason = (() => {
    if (loading || validation.error) return null;
    if (!parsed) return `Enter an amount to ${mode}.`;
    return null;
  })();

  return (
    <div
      id="stake"
      className={`panel p-5 sm:p-6 space-y-5 scroll-mt-24 ${shake ? "animate-shake" : ""}`}
    >
      <SectionTitle
        right={
          <div
            role="tablist"
            aria-label="Stake or unstake"
            className="flex bg-holder-900 rounded-lg p-1"
          >
            {(["stake", "unstake"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  setAmount("");
                }}
                className={`px-4 min-h-[36px] rounded-md text-sm font-semibold transition capitalize ${
                  mode === m
                    ? m === "stake"
                      ? "bg-holder-accent text-holder-900"
                      : "bg-holder-danger text-white"
                    : "text-ink-300 hover:text-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        }
      >
        Your Position
      </SectionTitle>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-holder-900/60 border border-holder-700/60 p-4">
          <p className="text-xs text-ink-300 uppercase tracking-wide">Staked</p>
          {known ? (
            <p className="text-xl font-bold stat-number mt-1">
              {formatAmount(staked, decimals)}{" "}
              <span className="text-sm text-ink-400 font-normal">{symbol}</span>
            </p>
          ) : (
            <Skeleton className="h-7 w-28 mt-1.5" />
          )}
        </div>
        <div className="rounded-xl bg-holder-900/60 border border-holder-success/25 p-4">
          <p className="text-xs text-ink-300 uppercase tracking-wide">
            Claimable
          </p>
          {known ? (
            <p className="text-xl font-bold stat-number text-holder-success mt-1">
              {formatAmount(pending, decimals)}{" "}
              <span className="text-sm text-ink-400 font-normal">{symbol}</span>
            </p>
          ) : (
            <Skeleton className="h-7 w-28 mt-1.5" />
          )}
        </div>
      </div>

      {mode === "stake" && hasNoHold ? (
        <div className="rounded-xl border border-holder-accent/30 bg-holder-accent/5 p-4 text-center space-y-2">
          <p className="text-sm text-ink-100 font-medium">
            You don&apos;t have any {symbol} yet.
          </p>
          <p className="text-xs text-ink-300">
            Swap a little SOL for {symbol} first — then come back and stake it.
          </p>
          <button
            onClick={onNeedHold}
            className="mt-1 px-5 py-2.5 rounded-xl text-sm font-bold bg-holder-accent text-holder-900 hover:bg-holder-accentBright transition"
          >
            Get {symbol} →
          </button>
        </div>
      ) : (
        <>
          <AmountField
            decimals={decimals}
            label={mode === "stake" ? "Amount to stake" : "Amount to unstake"}
            value={amount}
            onChange={setAmount}
            symbol={symbol}
            balance={spendable}
            balanceLabel={mode === "stake" ? "Wallet" : "Staked"}
            error={validation.error}
            hint={
              mode === "stake"
                ? "No tax on the way in. Every second staked earns you points."
                : "20% exit tax applies — see the breakdown below."
            }
          />

          {mode === "unstake" && parsed && !validation.error && (
            <div className="rounded-xl border border-holder-danger/30 bg-holder-danger/5 p-4 space-y-2">
              <ReceiptRow
                label="You receive"
                value={`${formatAmount(received, decimals)} ${symbol}`}
                tone="text-ink-100"
                emphasis
              />
              <ReceiptRow
                label="→ Jackpot vault (15%)"
                value={`${formatAmount(toVault, decimals)} ${symbol}`}
                tone="text-holder-jackpot"
              />
              <ReceiptRow
                label="🔥 Burned forever (5%)"
                value={`${formatAmount(burn, decimals)} ${symbol}`}
                tone="text-orange-400"
              />
              <p className="text-xs text-ink-400 pt-1 border-t border-holder-danger/20">
                This also resets the hold clock on the tokens you withdraw.
              </p>
            </div>
          )}

          <ActionButton
            tone={mode === "stake" ? "accent" : "danger"}
            loading={loading}
            loadingLabel={mode === "stake" ? "Staking…" : "Unstaking…"}
            disabled={submitDisabled}
            disabledReason={disabledReason}
            onClick={mode === "stake" ? stake : () => setConfirming(true)}
          >
            {mode === "stake" ? `Stake ${symbol}` : "Unstake and pay the tax"}
          </ActionButton>
        </>
      )}

      <ActionButton
        tone="success"
        loading={false}
        disabled={loading || !known || pending.isZero()}
        disabledReason={
          known && pending.isZero()
            ? "Nothing to claim yet — rebates accrue while you stay staked."
            : null
        }
        onClick={claim}
      >
        {known && pending.gtn(0)
          ? `Claim ${formatAmount(pending, decimals)} ${symbol}`
          : "Claim Rebate"}
      </ActionButton>

      {/*
        A 20% tax with 5% burned is irreversible. It used to happen on a single
        unguarded click.
      */}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm early exit"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setConfirming(false)}
              className="flex-1 min-h-[48px] rounded-xl font-bold border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
            >
              Keep holding
            </button>
            <button
              onClick={unstake}
              className="flex-1 min-h-[48px] rounded-xl font-bold bg-holder-danger text-white hover:bg-holder-dangerBright transition"
            >
              Pay the tax
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-200">
            You&apos;re withdrawing{" "}
            <strong className="text-ink-100">
              {formatAmount(parsed ?? new BN(0), decimals)} {symbol}
            </strong>
            . One fifth of it does not come with you, and the burn cannot be
            undone.
          </p>
          <div className="rounded-xl bg-holder-900/60 border border-holder-700 p-4 space-y-2">
            <ReceiptRow
              label="You receive"
              value={`${formatAmount(received, decimals)} ${symbol}`}
              emphasis
            />
            <ReceiptRow
              label="→ Jackpot vault"
              value={`${formatAmount(toVault, decimals)} ${symbol}`}
              tone="text-holder-jackpot"
            />
            <ReceiptRow
              label="🔥 Burned forever"
              value={`${formatAmount(burn, decimals)} ${symbol}`}
              tone="text-orange-400"
            />
          </div>
          <p className="text-xs text-ink-400">
            Everyone still staked splits the 15% you leave behind. Your name goes
            in the live feed under &ldquo;Paper hands&rdquo;.
          </p>
        </div>
      </Modal>
    </div>
  );
}
