"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { findSwapPoolPDA, findSwapPoolHoldVault, findTreasuryPDA, findVaultStatePDA, getProgram, getProvider } from "@/lib/program";
import { formatAmount, toDecimalString } from "@/lib/amount";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useMint } from "@/lib/mint";
import { useBalances, SOL_FEE_BUFFER_LAMPORTS } from "@/lib/balances";
import { usePoll } from "@/lib/usePoll";
import { AmountField, validateAmount } from "./AmountField";
import { ActionButton, ReceiptRow, SectionTitle, Skeleton } from "./ui";

/**
 * Creator-only liquidity controls. The on-chain `add_liquidity` instruction
 * takes SOL from the creator and community tokens from the treasury, so a
 * single transaction deepens the pool with both sides at once. The full
 * treasury balance is paired with whatever SOL the creator enters.
 */
export function LiquidityPanel({
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
  const { symbol, decimals } = useMint();

  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const [swapPoolPDA] = findSwapPoolPDA(mint);
  const [treasuryPDA] = findTreasuryPDA(mint);

  const { data, status, refetch } = usePoll(
    async () => {
      const treasuryTokenAccount = await getAssociatedTokenAddress(mint, treasuryPDA, true);
      const treasury = await getAccount(connection, treasuryTokenAccount)
        .then((a) => new BN(a.amount.toString()))
        .catch(() => new BN(0));

      const info = await connection.getAccountInfo(swapPoolPDA);
      let sol = 0;
      let hold = new BN(0);
      if (info) {
        const rent = await connection.getMinimumBalanceForRentExemption(info.data.length);
        sol = Math.max(0, info.lamports - rent) / LAMPORTS_PER_SOL;
        const holdVault = await findSwapPoolHoldVault(mint, swapPoolPDA);
        hold = await getAccount(connection, holdVault)
          .then((a) => new BN(a.amount.toString()))
          .catch(() => new BN(0));
      }
      return { treasury, sol, hold };
    },
    { intervalMs: 20000, staggerMs: 800 },
    [connection, swapPoolPDA.toBase58(), treasuryPDA.toBase58(), mint.toBase58()]
  );

  const treasury = data?.treasury ?? new BN(0);
  const poolSol = data?.sol ?? 0;
  const poolHold = data?.hold ?? new BN(0);

  const spendable = balances.lamports
    ? BN.max(balances.lamports.sub(SOL_FEE_BUFFER_LAMPORTS), new BN(0))
    : null;
  const validation = useMemo(
    () =>
      validateAmount(amount, {
        balance: spendable,
        decimals: 9,
        symbol: "SOL",
        minLabel: "available after fees",
      }),
    [amount, spendable]
  );

  const solWhole = validation.value
    ? Number(toDecimalString(validation.value, 9))
    : 0;

  const add = async () => {
    if (!wallet.publicKey || solWhole <= 0 || validation.error) return;
    setLoading(true);
    try {
      const program = getProgram(getProvider(connection, wallet));
      const [vaultPDA] = findVaultStatePDA(mint);
      const holdVault = await findSwapPoolHoldVault(mint, swapPoolPDA);
      const treasuryTokenAccount = await getAssociatedTokenAddress(mint, treasuryPDA, true);

      const signature = await program.methods
        .addLiquidity(new BN(Math.floor(solWhole * LAMPORTS_PER_SOL)), treasury)
        .accounts({
          vaultState: vaultPDA,
          swapPool: swapPoolPDA,
          mint,
          holdVault,
          treasury: treasuryPDA,
          treasuryTokenAccount,
          authority: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      setAmount("");
      refetch();
      balances.refetch();
      onUpdate();
      toast.show({
        kind: "success",
        title: "💧 Liquidity added",
        detail: `${solWhole.toFixed(4)} SOL + ${formatAmount(treasury, decimals)} ${symbol}`,
        signature,
      });
    } catch (err) {
      console.error(err);
      toast.show({
        kind: "danger",
        title: "Failed to add liquidity",
        detail: friendlyError(err),
        action: { label: "Try again", onClick: add },
      });
    } finally {
      setLoading(false);
    }
  };

  const treasuryEmpty = treasury.isZero();

  return (
    <div id="liquidity" className="panel p-5 sm:p-6 space-y-5 scroll-mt-24 border-holder-accent/25">
      <SectionTitle
        as="h3"
        right={
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-holder-accent/40 text-holder-accent">
            Creator only
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>💧</span> Add liquidity
        </span>
      </SectionTitle>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-holder-800/60 p-3">
          <p className="text-ink-400 uppercase tracking-wide text-[10px]">Pool</p>
          <p className="stat-number text-ink-100 font-semibold mt-1">
            {status === "loading" ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              `${poolSol.toFixed(3)} SOL · ${formatAmount(poolHold, decimals, { min: 0, max: 0 })} ${symbol}`
            )}
          </p>
        </div>
        <div className="rounded-lg bg-holder-800/60 p-3">
          <p className="text-ink-400 uppercase tracking-wide text-[10px]">Treasury</p>
          <p className="stat-number text-ink-100 font-semibold mt-1">
            {status === "loading" ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              `${formatAmount(treasury, decimals, { min: 0, max: 0 })} ${symbol}`
            )}
          </p>
        </div>
      </div>

      <AmountField
        label="SOL to add"
        value={amount}
        onChange={setAmount}
        symbol="SOL"
        decimals={9}
        balance={balances.lamports}
        spendable={spendable}
        balanceLabel="Wallet"
        error={validation.error}
        hint={
          treasuryEmpty
            ? "The treasury is empty, so this adds SOL only (deepens the pool, raises the price)."
            : "Pairs with the full treasury balance above."
        }
      />

      {!treasuryEmpty && (
        <div className="rounded-xl bg-holder-900/60 border border-holder-700/60 p-4 space-y-2">
          <ReceiptRow label="SOL you add" value={`${solWhole > 0 ? solWhole.toFixed(4) : "0.0000"} SOL`} />
          <ReceiptRow label="Tokens from treasury" value={`${formatAmount(treasury, decimals)} ${symbol}`} />
          <ReceiptRow
            label="Result"
            value={`${poolSol.toFixed(3)} + ${solWhole.toFixed(4)} SOL · ${formatAmount(poolHold.add(treasury), decimals)} ${symbol}`}
            emphasis
          />
        </div>
      )}

      <ActionButton
        loading={loading}
        loadingLabel="Adding liquidity…"
        disabled={loading || !wallet.publicKey || solWhole <= 0 || !!validation.error}
        disabledReason={!wallet.publicKey ? "Connect your wallet." : solWhole <= 0 ? "Enter an amount of SOL to add." : undefined}
        onClick={add}
      >
        Add liquidity
      </ActionButton>
    </div>
  );
}
