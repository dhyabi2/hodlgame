"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { AnchorProvider, BN, Program, EventParser } from "@coral-xyz/anchor";
import { PROGRAM_ID, formatAmount } from "@/lib/program";
import { getAchievements } from "@/lib/achievements";
import { getHoldingScore } from "@/lib/tiers";
import idl from "@/lib/idl.json";

const HISTORY_LIMIT = 30;

interface Stats {
  totalStaked: BN;
  totalTaxPaid: BN;
  totalBurned: BN;
  totalClaimed: BN;
  raffleWins: number;
}

const EMPTY: Stats = {
  totalStaked: new BN(0),
  totalTaxPaid: new BN(0),
  totalBurned: new BN(0),
  totalClaimed: new BN(0),
  raffleWins: 0,
};

export function PersonalStats({
  position,
}: {
  position?: { amount: BN; points: BN } | null;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!wallet.publicKey) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const owner = wallet.publicKey;

    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program<any>(idl as any, PROGRAM_ID, provider);
    const parser = new EventParser(PROGRAM_ID, program.coder);

    const fetchStats = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(owner, {
          limit: HISTORY_LIMIT,
        });
        const acc: Stats = {
          totalStaked: new BN(0),
          totalTaxPaid: new BN(0),
          totalBurned: new BN(0),
          totalClaimed: new BN(0),
          raffleWins: 0,
        };
        for (const sig of sigs) {
          if (sig.err) continue;
          const tx = await connection.getTransaction(sig.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const logs = tx?.meta?.logMessages;
          if (!logs) continue;
          for (const parsed of parser.parseLogs(logs)) {
            const data: any = parsed.data;
            if (parsed.name === "StakeEvent" && data.user.equals(owner)) {
              acc.totalStaked = acc.totalStaked.add(data.amount);
            }
            if (parsed.name === "UnstakeEvent" && data.user.equals(owner)) {
              acc.totalTaxPaid = acc.totalTaxPaid.add(data.tax);
              acc.totalBurned = acc.totalBurned.add(data.burn);
            }
            if (parsed.name === "ClaimEvent" && data.user.equals(owner)) {
              acc.totalClaimed = acc.totalClaimed.add(data.amount);
            }
            if (parsed.name === "RaffleEvent" && data.winner.equals(owner)) {
              acc.raffleWins += 1;
              acc.totalClaimed = acc.totalClaimed.add(data.prize);
            }
          }
        }
        if (!cancelled) setStats(acc);
      } catch (err) {
        console.error("personal stats fetch error", err);
      }
    };

    fetchStats();
    return () => {
      cancelled = true;
    };
  }, [connection, wallet.publicKey]);

  if (!wallet.publicKey) return null;
  const s = stats ?? EMPTY;
  const hasActivity =
    stats !== null &&
    (s.totalStaked.gtn(0) || s.totalTaxPaid.gtn(0) || s.totalClaimed.gtn(0));

  const avgHoldDays = position
    ? getHoldingScore(position.points, position.amount).avgHoldDays
    : 0;
  const achievements = getAchievements({
    stakedAmount: position?.amount ?? new BN(0),
    avgHoldDays,
    totalStaked: s.totalStaked,
    totalTaxPaid: s.totalTaxPaid,
    totalBurned: s.totalBurned,
    totalClaimed: s.totalClaimed,
    raffleWins: s.raffleWins,
  });
  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  return (
    <div className="panel p-6">
      <h3 className="text-sm uppercase tracking-wider text-ink-300 mb-3">
        Your History
      </h3>
      {stats === null ? (
        <p className="text-sm text-ink-400">Loading...</p>
      ) : !hasActivity ? (
        <p className="text-sm text-ink-400">
          No activity yet in your recent history. Stake to start your story.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Total Staked" value={`${formatAmount(s.totalStaked)} HOLD`} />
          <Stat label="Total Claimed" value={`${formatAmount(s.totalClaimed)} HOLD`} accent="text-holder-success" />
          <Stat label="Tax Paid" value={`${formatAmount(s.totalTaxPaid)} HOLD`} accent="text-holder-danger" />
          <Stat label="Burned Forever" value={`${formatAmount(s.totalBurned)} HOLD`} accent="text-orange-400" />
          {s.raffleWins > 0 && (
            <div className="col-span-2">
              <Stat label="Raffle Wins" value={`🎉 ${s.raffleWins}`} accent="text-holder-jackpot" />
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-ink-500 mt-3">
        Based on your last {HISTORY_LIMIT} transactions.
      </p>

      {stats !== null && (
        <div className="mt-5 pt-5 border-t border-holder-700">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm uppercase tracking-wider text-ink-300">
              Achievements
            </h3>
            <span className="text-xs text-ink-400">
              {unlockedCount}/{achievements.length}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {achievements.map((a) => (
              <div
                key={a.id}
                title={`${a.name} — ${a.description}`}
                className={`rounded-xl p-2 text-center border transition ${
                  a.unlocked
                    ? "bg-holder-jackpot/10 border-holder-jackpot/40"
                    : "bg-holder-900/40 border-holder-700 opacity-40 grayscale"
                }`}
              >
                <p className="text-xl leading-none">{a.emoji}</p>
                <p
                  className={`text-[10px] mt-1 leading-tight ${
                    a.unlocked ? "text-holder-jackpot" : "text-ink-400"
                  }`}
                >
                  {a.name}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl bg-holder-900/50 p-3">
      <p className="text-xs text-ink-400 uppercase tracking-wide">{label}</p>
      <p className={`font-bold mt-0.5 ${accent ?? ""}`}>{value}</p>
    </div>
  );
}
