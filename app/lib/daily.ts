"use client";

/**
 * Daily check-in streak + daily quests.
 *
 * The streak and "did an action today" flags are necessarily local
 * (localStorage) — there's no on-chain record of "visited the site." The
 * *holding* quest, though, is checked against real on-chain position, so it
 * can't be faked by clearing storage.
 */

const STREAK_KEY = "holder:streak";
const LAST_VISIT_KEY = "holder:lastVisit";
const ACTION_KEY_PREFIX = "holder:actedOn:";

/** Local date key (YYYY-MM-DD) so streaks roll over at the user's midnight. */
export function todayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return todayKey(d);
}

export interface StreakState {
  streak: number;
  isNewDay: boolean;
  brokenFrom: number | null;
}

/**
 * Records today's visit and returns the resulting streak. Idempotent within a
 * day — calling it repeatedly won't inflate the count.
 */
export function recordVisit(): StreakState {
  if (typeof window === "undefined") {
    return { streak: 0, isNewDay: false, brokenFrom: null };
  }
  const today = todayKey();
  const last = window.localStorage.getItem(LAST_VISIT_KEY);
  const stored = parseInt(window.localStorage.getItem(STREAK_KEY) ?? "0", 10);
  const prev = Number.isFinite(stored) ? stored : 0;

  if (last === today) {
    return { streak: prev, isNewDay: false, brokenFrom: null };
  }

  let next: number;
  let brokenFrom: number | null = null;
  if (last === yesterdayKey()) {
    next = prev + 1;
  } else {
    if (prev > 1) brokenFrom = prev;
    next = 1;
  }

  window.localStorage.setItem(LAST_VISIT_KEY, today);
  window.localStorage.setItem(STREAK_KEY, String(next));
  return { streak: next, isNewDay: true, brokenFrom };
}

/** Flag that the user completed an on-chain action today (stake/swap/claim). */
export function markActedToday() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${ACTION_KEY_PREFIX}${todayKey()}`, "1");
}

export function actedToday(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(`${ACTION_KEY_PREFIX}${todayKey()}`) === "1";
}

export interface Quest {
  id: string;
  label: string;
  hint: string;
  done: boolean;
}

export function buildQuests(opts: {
  visited: boolean;
  isStaked: boolean;
  acted: boolean;
}): Quest[] {
  return [
    {
      id: "checkin",
      label: "Check in at the vault",
      hint: "Just showing up counts.",
      done: opts.visited,
    },
    {
      id: "holding",
      label: "Hold a position",
      hint: "Verified on-chain — you have HOLD staked right now.",
      done: opts.isStaked,
    },
    {
      id: "act",
      label: "Make a move",
      hint: "Stake, swap, or claim once today.",
      done: opts.acted,
    },
  ];
}
