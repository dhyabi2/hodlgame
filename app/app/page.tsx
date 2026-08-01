"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { StakePanel } from "@/components/StakePanel";
import { SwapPanel } from "@/components/SwapPanel";
import { LiveFeed } from "@/components/LiveFeed";
import { Leaderboard } from "@/components/Leaderboard";
import { DiamondHero } from "@/components/DiamondHero";
import { StreakMeter } from "@/components/StreakMeter";
import { SoundToggle } from "@/components/SoundToggle";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import {
  findVaultStatePDA,
  findVaultTokenAccount,
  formatAmount,
  PROGRAM_ID,
} from "@/lib/program";
import idl from "@/lib/idl.json";

const MINT = new PublicKey(process.env.NEXT_PUBLIC_MINT!);

function toUnits(amountStr: string): number {
  return parseFloat(amountStr.replace(/,/g, ""));
}

export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [balance, setBalance] = useState<string>("0");
  const [totalStaked, setTotalStaked] = useState<string>("0");
  const [jackpot, setJackpot] = useState<string>("0");
  const [position, setPosition] = useState<{ amount: BN; points: BN } | null>(
    null
  );
  const [refreshTick, setRefreshTick] = useState(0);

  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Public vault stats — readable without a connected wallet.
  useEffect(() => {
    const [vaultPDA] = findVaultStatePDA(MINT);
    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program<any>(idl as any, PROGRAM_ID, provider);

    const fetchPublicData = async () => {
      try {
        const vaultAta = await findVaultTokenAccount(MINT, vaultPDA);
        try {
          const vaultAcc = await getAccount(connection, vaultAta);
          setJackpot(formatAmount(Number(vaultAcc.amount)));
        } catch {
          setJackpot("0");
        }

        const vault = await (program.account as any).vaultState.fetchNullable(
          vaultPDA
        );
        if (vault) {
          setTotalStaked(formatAmount(vault.totalStaked));
        }
      } catch (err) {
        console.error(err);
      }
    };

    fetchPublicData();
    const id = setInterval(fetchPublicData, 12000);
    return () => clearInterval(id);
  }, [connection, refreshTick]);

  // User's own token balance — needs a connected wallet.
  useEffect(() => {
    if (!wallet.publicKey) {
      setBalance("0");
      return;
    }

    const fetchBalance = async () => {
      try {
        const ata = await getAssociatedTokenAddress(MINT, wallet.publicKey!);
        const acc = await getAccount(connection, ata).catch(() => null);
        setBalance(formatAmount(acc ? Number(acc.amount) : 0));
      } catch (err) {
        console.error(err);
      }
    };

    fetchBalance();
    const id = setInterval(fetchBalance, 12000);
    return () => clearInterval(id);
  }, [connection, wallet.publicKey, refreshTick]);

  return (
    <main className="min-h-screen p-6 md:p-12">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl md:text-5xl font-bold bg-gradient-to-r from-holder-accent to-emerald-400 bg-clip-text text-transparent">
              💎 HOLDER
            </h1>
            <p className="text-slate-400 mt-1">
              Stake. Wait. Tax the paper hands. Earn rebates.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SoundToggle />
            <WalletMultiButton className="!bg-holder-accent !text-holder-900 !font-bold hover:!bg-cyan-300" />
          </div>
        </header>

        <DiamondHero jackpot={toUnits(jackpot)} totalStaked={toUnits(totalStaked)} />

        {!wallet.publicKey ? (
          <div className="rounded-2xl border border-holder-700 bg-holder-800/50 p-12 text-center">
            <p className="text-xl text-slate-300">
              Connect your wallet to swap for HOLD and join the holding game.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-8">
              <SwapPanel mint={MINT} onUpdate={bumpRefresh} />
              {position && (
                <StreakMeter points={position.points} amount={position.amount} />
              )}
              <StakePanel mint={MINT} onUpdate={bumpRefresh} onPosition={setPosition} />
            </div>
            <div className="space-y-8">
              <LiveFeed />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {!wallet.publicKey && <LiveFeed />}
          <Leaderboard />
        </div>

        <footer className="text-center text-xs text-slate-600 pb-6">
          Your balance: <AnimatedNumber value={toUnits(balance)} decimals={2} /> HOLD
          {" · "}Devnet MVP — not financial advice.
        </footer>
      </div>
    </main>
  );
}
