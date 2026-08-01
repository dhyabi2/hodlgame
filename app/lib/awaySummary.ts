"use client";

/**
 * "While you were away" — snapshots real vault numbers at each visit and, when
 * you return after a meaningful gap, reports what actually changed. The deltas
 * are computed from genuine on-chain reads (jackpot balance, total staked),
 * never invented.
 */

const KEY = "holder:lastSnapshot";
/** Gaps shorter than this aren't "away", they're a page refresh. */
const MIN_AWAY_MS = 6 * 60 * 60 * 1000;

interface Snapshot {
  at: number;
  jackpot: number;
  totalStaked: number;
}

export interface AwayReport {
  hoursAway: number;
  jackpotDelta: number;
  stakedDelta: number;
}

/**
 * Call once per session with the first real numbers. Returns a report if the
 * user was genuinely away and something changed, else null. Always refreshes
 * the stored snapshot.
 */
export function checkAway(jackpot: number, totalStaked: number): AwayReport | null {
  if (typeof window === "undefined") return null;

  let prev: Snapshot | null = null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) prev = JSON.parse(raw) as Snapshot;
  } catch {
    prev = null;
  }

  const now = Date.now();
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ at: now, jackpot, totalStaked } satisfies Snapshot)
  );

  if (!prev || typeof prev.at !== "number") return null;
  const awayMs = now - prev.at;
  if (awayMs < MIN_AWAY_MS) return null;

  const jackpotDelta = jackpot - (prev.jackpot ?? 0);
  const stakedDelta = totalStaked - (prev.totalStaked ?? 0);
  // Nothing moved — a "nothing happened" toast is noise, not a welcome back.
  if (Math.abs(jackpotDelta) < 0.01 && Math.abs(stakedDelta) < 0.01) return null;

  return {
    hoursAway: Math.round(awayMs / 3_600_000),
    jackpotDelta,
    stakedDelta,
  };
}

export function describeAway(r: AwayReport): string {
  const parts: string[] = [];
  if (Math.abs(r.jackpotDelta) >= 0.01) {
    parts.push(
      r.jackpotDelta > 0
        ? `the jackpot grew ${r.jackpotDelta.toFixed(2)} HOLD`
        : `the jackpot paid out ${Math.abs(r.jackpotDelta).toFixed(2)} HOLD`
    );
  }
  if (Math.abs(r.stakedDelta) >= 0.01) {
    parts.push(
      r.stakedDelta > 0
        ? `${r.stakedDelta.toFixed(2)} HOLD more was staked`
        : `${Math.abs(r.stakedDelta).toFixed(2)} HOLD left the vault`
    );
  }
  return `In the ~${r.hoursAway}h you were gone: ${parts.join(", and ")}.`;
}
