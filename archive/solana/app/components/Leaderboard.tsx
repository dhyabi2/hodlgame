"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { formatAmount } from "@/lib/amount";
import { useMint } from "@/lib/mint";
import { getHoldingScore } from "@/lib/tiers";
import { useStakers, type Staker } from "@/lib/stakers";
import { addressUrl, shortAddress } from "@/lib/explorer";
import { EmptyState, LoadError, SectionTitle, SkeletonRows } from "./ui";

const TOP_N = 10;
const MEDALS = ["🥇", "🥈", "🥉"];

export function Leaderboard({ onStake }: { onStake?: () => void }) {
  const wallet = useWallet();
  const { stakers, status, refetch } = useStakers();
  const { symbol, decimals } = useMint();
  const [tab, setTab] = useState<"stakers" | "diamond">("stakers");
  const me = wallet.publicKey?.toBase58() ?? null;

  const ranked = useMemo(() => {
    const rows = [...(stakers ?? [])];
    rows.sort(
      tab === "stakers"
        ? (a, b) => (a.amount.lt(b.amount) ? 1 : -1)
        : (a, b) => b.avgHoldSeconds - a.avgHoldSeconds
    );
    return rows;
  }, [stakers, tab]);

  const list = ranked.slice(0, TOP_N);
  const myIndex = me ? ranked.findIndex((r) => r.owner === me) : -1;
  // If you're 11th you were previously invisible on your own leaderboard.
  const showMyRow = myIndex >= TOP_N;

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
      if (before !== undefined && before !== i) moved[row.owner] = before - i;
    });
    prevRanks.current[tab] = next;
    if (Object.keys(moved).length > 0) {
      setDeltas(moved);
      const id = setTimeout(() => setDeltas({}), 6000);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stakers, tab]);

  return (
    <div id="leaderboard" className="panel p-5 sm:p-6 scroll-mt-24">
      <SectionTitle
        right={
          <div role="tablist" aria-label="Leaderboard ranking" className="flex bg-holder-900 rounded-lg p-1">
            <button
              role="tab"
              aria-selected={tab === "stakers"}
              onClick={() => setTab("stakers")}
              className={`px-3 min-h-[36px] rounded-md text-xs font-semibold transition ${
                tab === "stakers"
                  ? "bg-holder-accent text-holder-900"
                  : "text-ink-300 hover:text-white"
              }`}
            >
              Biggest
            </button>
            <button
              role="tab"
              aria-selected={tab === "diamond"}
              onClick={() => setTab("diamond")}
              className={`px-3 min-h-[36px] rounded-md text-xs font-semibold transition ${
                tab === "diamond"
                  ? "bg-holder-accent text-holder-900"
                  : "text-ink-300 hover:text-white"
              }`}
            >
              Longest held
            </button>
          </div>
        }
      >
        Leaderboard
      </SectionTitle>

      <div className="mt-4">
        {status === "error" && !stakers ? (
          <LoadError what="the leaderboard" onRetry={refetch} />
        ) : stakers === null ? (
          <SkeletonRows rows={5} />
        ) : list.length === 0 ? (
          <EmptyState
            icon="🏆"
            title="This leaderboard is wide open."
            body="Nobody is staked yet. Stake now and claim rank #1 before anyone else does."
            action={onStake ? { label: "Take rank #1", onClick: onStake } : undefined}
          />
        ) : (
          <>
            <ol className="space-y-2">
              {list.map((row, i) => (
                <Row
                  key={row.owner}
                  row={row}
                  rank={i}
                  tab={tab}
                  isYou={row.owner === me}
                  delta={deltas[row.owner]}
                  symbol={symbol}
                  decimals={decimals}
                />
              ))}
            </ol>

            {showMyRow && (
              <div className="mt-3 pt-3 border-t border-dashed border-holder-700">
                <p className="text-xs text-ink-400 mb-2">Your position</p>
                <ol>
                  <Row
                    row={ranked[myIndex]}
                    rank={myIndex}
                    tab={tab}
                    isYou
                    delta={undefined}
                    symbol={symbol}
                    decimals={decimals}
                  />
                </ol>
                <p className="text-xs text-ink-400 mt-2">
                  {myIndex - TOP_N + 1} place
                  {myIndex - TOP_N + 1 === 1 ? "" : "s"} from the top ten.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  rank,
  tab,
  isYou,
  delta,
  symbol,
  decimals,
}: {
  row: Staker;
  rank: number;
  tab: "stakers" | "diamond";
  isYou: boolean;
  delta: number | undefined;
  symbol: string;
  decimals: number;
}) {
  const score = getHoldingScore(row.points, row.amount);
  return (
    <li
      className={`flex items-center justify-between gap-3 rounded-xl p-3 ${
        isYou
          ? "bg-holder-accent/10 border border-holder-accent/50"
          : "bg-holder-900/50"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-6 text-center text-sm text-ink-300 stat-number tabular-nums">
          {rank < 3 ? <span aria-hidden>{MEDALS[rank]}</span> : rank + 1}
          <span className="sr-only">Rank {rank + 1}</span>
        </span>
        {isYou ? (
          <span className="font-semibold text-sm text-holder-accent truncate">
            You
          </span>
        ) : (
          <a
            href={addressUrl(row.owner)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-sm text-ink-200 hover:text-holder-accent transition truncate"
            title={row.owner}
          >
            {shortAddress(row.owner)}
          </a>
        )}
        {delta !== undefined && (
          <span
            className={`text-xs font-bold shrink-0 ${
              delta > 0 ? "text-holder-success" : "text-holder-dangerBright"
            }`}
          >
            <span aria-hidden>{delta > 0 ? "▲" : "▼"}</span>
            {Math.abs(delta)}
            <span className="sr-only">
              {delta > 0 ? " places up" : " places down"}
            </span>
          </span>
        )}
      </div>
      <div className="text-right shrink-0">
        {tab === "stakers" ? (
          <p className="font-bold text-sm stat-number tabular-nums">
            {formatAmount(row.amount, decimals)}{" "}
            <span className="text-ink-400 font-normal">{symbol}</span>
          </p>
        ) : (
          <p className={`font-bold text-sm ${score.tier.color}`}>
            <span aria-hidden>{score.tier.emoji}</span> {score.tier.name}{" "}
            <span className="text-ink-400 font-normal tabular-nums">
              · {score.avgHoldDays.toFixed(2)}d
            </span>
          </p>
        )}
      </div>
    </li>
  );
}
