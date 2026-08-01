"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { StakePanel } from "@/components/StakePanel";
import { SwapPanel } from "@/components/SwapPanel";
import { RafflePanel } from "@/components/RafflePanel";
import { LiveFeed } from "@/components/LiveFeed";
import { Leaderboard } from "@/components/Leaderboard";
import { DiamondHero } from "@/components/DiamondHero";
import { StreakMeter } from "@/components/StreakMeter";
import { SoundToggle } from "@/components/SoundToggle";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { SplashIntro } from "@/components/SplashIntro";
import { HowItWorks } from "@/components/HowItWorks";
import { PersonalStats } from "@/components/PersonalStats";
import { AmbientParticles } from "@/components/AmbientParticles";
import {
  findVaultStatePDA,
  findVaultTokenAccount,
  formatAmount,
  PROGRAM_ID,
} from "@/lib/program";
import { getHoldingScore } from "@/lib/tiers";
import { useToast } from "@/lib/toast";
import idl from "@/lib/idl.json";
import { motion, useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";

const MINT = new PublicKey(process.env.NEXT_PUBLIC_MINT!);

function toUnits(amountStr: string): number {
  return parseFloat(amountStr.replace(/,/g, ""));
}

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

const MILESTONES = [
  {
    id: "first-stake",
    check: (avgHoldDays: number, amount: BN) => amount.gtn(0),
    title: "💎 First stake!",
    detail: "Welcome to the vault. Patience pays here.",
  },
  {
    id: "first-day",
    check: (avgHoldDays: number) => avgHoldDays >= 1,
    title: "🥉 24 hours held!",
    detail: "You've graduated from Paper hands. Bronze tier unlocked.",
  },
  {
    id: "diamond-tier",
    check: (avgHoldDays: number) => avgHoldDays >= 14,
    title: "💎 Diamond tier reached!",
    detail: "14 days held. You're the exact reason paper hands pay tax.",
  },
] as const;

export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [balance, setBalance] = useState<string>("0");
  const [totalStaked, setTotalStaked] = useState<string>("0");
  const [jackpot, setJackpot] = useState<string>("0");
  const [position, setPosition] = useState<{ amount: BN; points: BN } | null>(
    null
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const [statsLoaded, setStatsLoaded] = useState(false);

  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Milestone toasts — fire once per wallet the first time each condition is true.
  useEffect(() => {
    if (!position || !wallet.publicKey) return;
    const score = getHoldingScore(position.points, position.amount);
    for (const milestone of MILESTONES) {
      if (!milestone.check(score.avgHoldDays, position.amount)) continue;
      const key = `holder:milestone:${wallet.publicKey.toBase58()}:${milestone.id}`;
      if (window.localStorage.getItem(key)) continue;
      window.localStorage.setItem(key, "1");
      toast.push("success", milestone.title, milestone.detail);
      if (!reduceMotion) {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
          colors: ["#22d3ee", "#34d399", "#fbbf24"],
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, wallet.publicKey]);

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
      } finally {
        setStatsLoaded(true);
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
    <main className="min-h-screen p-6 md:p-12 relative overflow-hidden">
      <AmbientParticles />
      <SplashIntro />
      <motion.div
        className="max-w-6xl mx-auto space-y-8 relative z-10"
        variants={reduceMotion ? undefined : containerVariants}
        initial={reduceMotion ? undefined : "hidden"}
        animate={reduceMotion ? undefined : "show"}
      >
        <motion.header
          variants={reduceMotion ? undefined : itemVariants}
          className="flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div>
            <h1 className="font-display text-4xl md:text-5xl font-bold bg-gradient-to-r from-holder-accent to-emerald-400 bg-clip-text text-transparent">
              💎 HOLDER
            </h1>
            <p className="text-slate-400 mt-1">
              Paper hands pay the tax. Diamond hands collect it.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SoundToggle />
            <WalletMultiButton className="!bg-holder-accent !text-holder-900 !font-bold hover:!bg-cyan-300" />
          </div>
        </motion.header>

        <motion.div variants={reduceMotion ? undefined : itemVariants}>
          <HowItWorks />
        </motion.div>

        <motion.div variants={reduceMotion ? undefined : itemVariants}>
          <DiamondHero
            jackpot={toUnits(jackpot)}
            totalStaked={toUnits(totalStaked)}
            loading={!statsLoaded}
          />
        </motion.div>

        <motion.div variants={reduceMotion ? undefined : itemVariants}>
          <RafflePanel mint={MINT} onUpdate={bumpRefresh} />
        </motion.div>

        <motion.div variants={reduceMotion ? undefined : itemVariants}>
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
                <PersonalStats />
              </div>
              <div className="space-y-8">
                <LiveFeed />
              </div>
            </div>
          )}
        </motion.div>

        <motion.div
          variants={reduceMotion ? undefined : itemVariants}
          className="grid grid-cols-1 lg:grid-cols-2 gap-8"
        >
          {!wallet.publicKey && <LiveFeed />}
          <Leaderboard />
        </motion.div>

        <motion.footer
          variants={reduceMotion ? undefined : itemVariants}
          className="text-center text-xs text-slate-600 pb-6"
        >
          Your balance: <AnimatedNumber value={toUnits(balance)} decimals={2} /> HOLD
          {" · "}Devnet MVP — not financial advice.
        </motion.footer>
      </motion.div>
    </main>
  );
}
