"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { motion, useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";
import { StakePanel } from "@/components/StakePanel";
import { SwapPanel } from "@/components/SwapPanel";
import { LiquidityPanel } from "@/components/LiquidityPanel";
import { LiveFeed } from "@/components/LiveFeed";
import { Leaderboard } from "@/components/Leaderboard";
import { DiamondHero } from "@/components/DiamondHero";
import { Header } from "@/components/Header";
import { SectionNav, type NavSection } from "@/components/SectionNav";
import { ProgressPanel } from "@/components/ProgressPanel";
import { PersonalStats } from "@/components/PersonalStats";
import { AmbientParticles } from "@/components/AmbientParticles";
import { TierAura } from "@/components/TierAura";
import { SafetyPanel } from "@/components/SafetyPanel";
import { LoadError } from "@/components/ui";
import {
  findVaultStatePDA,
  findVaultTokenAccount,
  PROGRAM_ID,
} from "@/lib/program";
import { getHoldingScore } from "@/lib/tiers";
import { useToast } from "@/lib/toast";
import { usePoll } from "@/lib/usePoll";
import { useMint } from "@/lib/mint";
import { checkAway, describeAway } from "@/lib/awaySummary";
import { NETWORK_LABEL } from "@/lib/explorer";
import type { GameSummary } from "@/lib/games";
import idl from "@/lib/idl.json";

const containerVariants = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
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

const SECTIONS: NavSection[] = [
  { id: "vault", label: "Vault", icon: "💎" },
  { id: "stake", label: "Stake", icon: "🔒" },
  { id: "liquidity", label: "Liquidity", icon: "💧" },
  { id: "activity", label: "Activity", icon: "📡" },
  { id: "leaderboard", label: "Ranks", icon: "🏆" },
];

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function GameView({ game }: { game: GameSummary }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const { mint, symbol, decimals } = useMint();

  const [position, setPosition] = useState<{ amount: BN; points: BN } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const awayChecked = useRef(false);

  const { data: vaultStats, status, refetch } = usePoll(
    async () => {
      const [vaultPDA] = findVaultStatePDA(mint);
      const provider = new AnchorProvider(
        connection,
        {} as any,
        AnchorProvider.defaultOptions()
      );
      const program = new Program<any>(idl as any, PROGRAM_ID, provider);

      const vaultAta = await findVaultTokenAccount(mint, vaultPDA);
      const jackpot = await connection
        .getTokenAccountBalance(vaultAta)
        .then((r) => Number(r.value.amount) / 10 ** decimals)
        .catch(() => 0);

      const vault = await (program.account as any).vaultState.fetchNullable(vaultPDA);
      const totalStaked = vault
        ? Number(vault.totalStaked.toString()) / 10 ** decimals
        : 0;

      return { jackpot, totalStaked };
    },
    { intervalMs: 20000, staggerMs: 0 },
    [connection, refreshTick, mint.toBase58()]
  );

  // Away summary is per-token, or every game would report the last one's deltas.
  useEffect(() => {
    if (!vaultStats || awayChecked.current) return;
    awayChecked.current = true;
    const report = checkAway(vaultStats.jackpot, vaultStats.totalStaked);
    if (report) {
      toast.push("info", "👋 While you were away", describeAway(report));
    }
  }, [vaultStats, toast]);

  useEffect(() => {
    if (!position || !wallet.publicKey) return;
    const score = getHoldingScore(position.points, position.amount);
    for (const milestone of MILESTONES) {
      if (!milestone.check(score.avgHoldDays, position.amount)) continue;
      const key = `holder:milestone:${mint.toBase58()}:${wallet.publicKey.toBase58()}:${milestone.id}`;
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
  }, [position, wallet.publicKey, mint]);

  const connected = !!wallet.publicKey;
  const jackpot = vaultStats?.jackpot ?? 0;
  const totalStaked = vaultStats?.totalStaked ?? 0;

  return (
    <>
      <a
        href="#vault"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-holder-accent focus:text-holder-900 focus:font-bold"
      >
        Skip to content
      </a>

      <AmbientParticles />
      <TierAura position={position} />

      <main id="top" className="min-h-screen px-4 sm:px-6 pb-28 md:pb-12 relative">
        <Header />

        <motion.div
          className="max-w-6xl mx-auto space-y-6 relative z-10 pt-2"
          variants={reduceMotion ? undefined : containerVariants}
          initial={reduceMotion ? undefined : "hidden"}
          animate={reduceMotion ? undefined : "show"}
        >
          <motion.div
            variants={reduceMotion ? undefined : itemVariants}
            id="vault"
            className="scroll-mt-24"
          >
            {status === "error" && !vaultStats ? (
              <div className="panel panel-hero p-8">
                <LoadError what="the vault" onRetry={refetch} />
              </div>
            ) : (
              <DiamondHero
                jackpot={jackpot}
                totalStaked={totalStaked}
                loading={status === "loading"}
                symbol={symbol}
                onPrimary={connected ? () => scrollTo("stake") : undefined}
                primaryLabel={connected ? "Go to your position" : undefined}
              />
            )}
          </motion.div>

          {/* Anyone can launch a token here, so the risks come before the game. */}
          <motion.div variants={reduceMotion ? undefined : itemVariants}>
            <SafetyPanel game={game} />
          </motion.div>

          <motion.div variants={reduceMotion ? undefined : itemVariants}>
            <SectionNav sections={SECTIONS} />
          </motion.div>

          {!connected && (
            <motion.div
              variants={reduceMotion ? undefined : itemVariants}
              className="panel p-8 text-center space-y-4"
            >
              <p className="text-4xl" aria-hidden>
                🔐
              </p>
              <div className="space-y-1">
                <p className="text-lg font-display font-bold text-ink-100">
                  Connect a wallet
                </p>
                <p className="text-sm text-ink-300 max-w-sm mx-auto">
                  You&apos;ll need SOL to buy {symbol}.
                </p>
              </div>
              <div className="flex justify-center">
                <WalletMultiButton className="!h-12 !rounded-xl !bg-holder-accent !text-holder-900 !font-bold hover:!bg-holder-accentBright" />
              </div>
            </motion.div>
          )}

          {connected && (
            <motion.div
              variants={reduceMotion ? undefined : itemVariants}
              className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start"
            >
              <div className="space-y-6">
                <StakePanel
                  mint={mint}
                  onUpdate={bumpRefresh}
                  onPosition={setPosition}
                  onNeedHold={() => scrollTo("swap")}
                />
                <SwapPanel mint={mint} onUpdate={bumpRefresh} />
              </div>
              <div className="space-y-6">
                <ProgressPanel position={position} refreshTick={refreshTick} />
                <PersonalStats position={position} refreshTick={refreshTick} />
              </div>
            </motion.div>
          )}

          {connected && wallet.publicKey?.toBase58() === game.authority && (
            <motion.div variants={reduceMotion ? undefined : itemVariants}>
              <LiquidityPanel mint={mint} onUpdate={bumpRefresh} />
            </motion.div>
          )}

          <motion.div
            variants={reduceMotion ? undefined : itemVariants}
            className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start"
          >
            <LiveFeed onStake={() => scrollTo(connected ? "stake" : "vault")} />
            <Leaderboard onStake={() => scrollTo(connected ? "stake" : "vault")} />
          </motion.div>

          <motion.footer
            variants={reduceMotion ? undefined : itemVariants}
            className="text-center text-xs text-ink-400 pt-4 pb-6 space-y-1"
          >
            <a href="/" className="hover:text-holder-accent underline underline-offset-2">
              ← All coins
            </a>
            <p>{NETWORK_LABEL} · Not financial advice.</p>
          </motion.footer>
        </motion.div>
      </main>
    </>
  );
}

export type { PublicKey };
