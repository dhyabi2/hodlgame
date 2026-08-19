"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN, Program, EventParser } from "@coral-xyz/anchor";
import { PROGRAM_ID } from "@/lib/program";
import { formatAmount } from "@/lib/amount";
import { useMint } from "@/lib/mint";
import { usePoll } from "@/lib/usePoll";
import { LoadError, Skeleton } from "./ui";
import idl from "@/lib/idl.json";

const HISTORY_LIMIT = 30;

interface Stats {
  totalStaked: BN;
  totalTaxPaid: BN;
  totalBurned: BN;
  totalClaimed: BN;
}

export function PersonalStats({
  position,
  refreshTick,
}: {
  position?: { amount: BN; points: BN } | null;
  refreshTick: number;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const owner = wallet.publicKey;
  const { symbol, decimals } = useMint();

  const { data: stats, status, refetch } = usePoll<Stats>(
    async () => {
      const provider = new AnchorProvider(
        connection,
        {} as any,
        AnchorProvider.defaultOptions()
      );
      const program = new Program<any>(idl as any, PROGRAM_ID, provider);
      const parser = new EventParser(PROGRAM_ID, program.coder);

      const acc: Stats = {
        totalStaked: new BN(0),
        totalTaxPaid: new BN(0),
        totalBurned: new BN(0),
        totalClaimed: new BN(0),
      };
      if (!owner) return acc;

      const sigs = await connection.getSignaturesForAddress(owner, {
        limit: HISTORY_LIMIT,
      });
      const wanted = sigs.filter((s) => !s.err).map((s) => s.signature);
      if (wanted.length === 0) return acc;

      // One batched RPC round instead of 30 sequential `getTransaction` calls.
      const txs = await connection.getTransactions(wanted, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      for (const tx of txs) {
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
        }
      }
      return acc;
    },
    { intervalMs: 60000, enabled: !!owner, staggerMs: 1600 },
    // refreshTick: history used to go stale the moment you acted on it.
    [connection, owner?.toBase58(), refreshTick]
  );

  if (!owner) return null;

  const hasActivity =
    !!stats &&
    (stats.totalStaked.gtn(0) ||
      stats.totalTaxPaid.gtn(0) ||
      stats.totalClaimed.gtn(0));

  return (
    <div id="history" className="panel p-5 sm:p-6 space-y-4 scroll-mt-24">
      <p className="text-sm font-semibold text-ink-100">Your history</p>

      {status === "error" && !stats ? (
        <LoadError what="your history" onRetry={refetch} />
      ) : !stats ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : !hasActivity ? (
        <p className="text-sm text-ink-300">No activity yet. Stake to get started.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Staked" value={`${formatAmount(stats.totalStaked, decimals)} ${symbol}`} />
          <Stat
            label="Collected"
            value={`${formatAmount(stats.totalClaimed, decimals)} ${symbol}`}
            accent="text-holder-success"
          />
          <Stat
            label="Tax Paid"
            value={`${formatAmount(stats.totalTaxPaid, decimals)} ${symbol}`}
            accent="text-holder-dangerBright"
          />
          <Stat
            label="Burned"
            value={`${formatAmount(stats.totalBurned, decimals)} ${symbol}`}
            accent="text-orange-400"
          />
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
      <p className="text-xs text-ink-300 uppercase tracking-wide">{label}</p>
      <p className={`font-bold mt-0.5 stat-number tabular-nums ${accent ?? ""}`}>
        {value}
      </p>
    </div>
  );
}
