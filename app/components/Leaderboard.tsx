"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, formatAmount } from "@/lib/program";
import { getHoldingScore } from "@/lib/tiers";
import idl from "@/lib/idl.json";

interface StakeRow {
  owner: string;
  amount: BN;
  points: BN;
}

const REFRESH_MS = 15000;
const TOP_N = 10;

function short(pubkey: string) {
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

export function Leaderboard() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [rows, setRows] = useState<StakeRow[] | null>(null);
  const [tab, setTab] = useState<"stakers" | "diamond">("stakers");

  useEffect(() => {
    let cancelled = false;
    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program<any>(idl as any, PROGRAM_ID, provider);

    const load = async () => {
      try {
        const accounts = await (program.account as any).stakeAccount.all();
        if (cancelled) return;
        const mapped: StakeRow[] = accounts
          .map(({ account }: any) => ({
            owner: (account.owner as PublicKey).toBase58(),
            amount: account.amount as BN,
            points: account.points as BN,
          }))
          .filter((r: StakeRow) => r.amount.gtn(0));
        setRows(mapped);
      } catch (err) {
        console.error("leaderboard fetch error", err);
      }
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection]);

  const topStakers = [...(rows ?? [])]
    .sort((a, b) => (a.amount.lt(b.amount) ? 1 : -1))
    .slice(0, TOP_N);

  const topDiamonds = [...(rows ?? [])]
    .sort((a, b) => {
      const scoreA = getHoldingScore(a.points, a.amount).avgHoldSeconds;
      const scoreB = getHoldingScore(b.points, b.amount).avgHoldSeconds;
      return scoreB - scoreA;
    })
    .slice(0, TOP_N);

  const list = tab === "stakers" ? topStakers : topDiamonds;

  // Track the previous ranking per tab so we can show genuine movement between
  // refreshes. First render has no baseline, so nothing is marked as moved.
  const prevRanks = useRef<Record<string, Record<string, number>>>({
    stakers: {},
    diamond: {},
  });
  const [deltas, setDeltas] = useState<Record<string, number>>({});

  useEffect(() => {
    if (list.length === 0) return;
    const previous = prevRanks.current[tab];
    const next: Record<string, number> = {};
    const moved: Record<string, number> = {};
    list.forEach((row, i) => {
      next[row.owner] = i;
      const before = previous[row.owner];
      if (before !== undefined && before !== i) {
        moved[row.owner] = before - i; // positive = climbed
      }
    });
    prevRanks.current[tab] = next;
    if (Object.keys(moved).length > 0) {
      setDeltas(moved);
      const id = setTimeout(() => setDeltas({}), 6000);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab]);

  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Leaderboard</h2>
        <div className="flex bg-holder-900 rounded-lg p-1">
          <button
            onClick={() => setTab("stakers")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition ${
              tab === "stakers"
                ? "bg-holder-accent text-holder-900"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Top Stakers
          </button>
          <button
            onClick={() => setTab("diamond")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition ${
              tab === "diamond"
                ? "bg-holder-success text-holder-900"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Diamond Hands
          </button>
        </div>
      </div>

      {rows === null ? (
        <p className="text-slate-400 text-center py-8">Loading...</p>
      ) : list.length === 0 ? (
        <div className="text-center py-10 space-y-2">
          <p className="text-4xl">🏆</p>
          <p className="text-slate-300 font-medium">
            This leaderboard is wide open.
          </p>
          <p className="text-slate-500 text-sm">
            Stake now and claim rank #1 before anyone else does.
          </p>
        </div>
      ) : (
        <ol className="space-y-2">
          {list.map((row, i) => {
            const score = getHoldingScore(row.points, row.amount);
            const isYou = wallet.publicKey?.toBase58() === row.owner;
            return (
              <li
                key={row.owner}
                className={`flex items-center justify-between rounded-xl p-3 ${
                  isYou
                    ? "bg-holder-accent/10 border border-holder-accent/50"
                    : "bg-holder-900/50"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="w-5 text-center text-sm text-slate-500 font-mono">
                    {i + 1}
                  </span>
                  <span className="font-mono text-sm">
                    {isYou ? "👈 You" : short(row.owner)}
                  </span>
                  {deltas[row.owner] !== undefined && (
                    <span
                      title={`Moved ${Math.abs(deltas[row.owner])} place${
                        Math.abs(deltas[row.owner]) === 1 ? "" : "s"
                      }`}
                      className={`text-xs font-bold ${
                        deltas[row.owner] > 0
                          ? "text-holder-success"
                          : "text-holder-danger"
                      }`}
                    >
                      {deltas[row.owner] > 0 ? "▲" : "▼"}
                      {Math.abs(deltas[row.owner])}
                    </span>
                  )}
                </div>
                <div className="text-right">
                  {tab === "stakers" ? (
                    <p className="font-bold text-sm">
                      {formatAmount(row.amount)} HOLD
                    </p>
                  ) : (
                    <p className={`font-bold text-sm ${score.tier.color}`}>
                      {score.tier.emoji} {score.tier.name} ·{" "}
                      {score.avgHoldDays.toFixed(2)}d
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
