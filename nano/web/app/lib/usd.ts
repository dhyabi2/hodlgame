"use client";

// Live XNO→USD rate so market caps / prices / trade sizes can show a dollar
// figure an outsider understands. Fetched from OUR OWN /api/xno-usd (the server
// pulls CoinGecko once per cron tick and serves it to everyone), so the browser
// never calls CoinGecko directly — no CORS errors, no per-user rate limit.
// Cached 60s in module memory with a localStorage fallback so a rate survives
// reloads and a temporary outage degrades to the last known rate, never broken
// UI (every formatter accepts null and renders nothing).

import { useEffect, useState } from "react";
import { fmtNum } from "./trade";

let cache: { at: number; rate: number } | null = null;

export async function fetchXnoUsd(): Promise<number | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rate;
  try {
    const j = await (await fetch("/api/xno-usd")).json();
    const rate = Number(j?.rate);
    if (Number.isFinite(rate) && rate > 0) {
      cache = { at: Date.now(), rate };
      try { localStorage.setItem("holdfun-xno-usd", String(rate)); } catch {}
      return rate;
    }
  } catch {}
  if (cache) return cache.rate;
  try {
    const stored = Number(localStorage.getItem("holdfun-xno-usd"));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {}
  return null;
}

/** Live rate as a hook — refreshes every 60s. null until known. */
export function useXnoUsd(): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetchXnoUsd().then((r) => { if (live && r != null) setRate(r); });
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return rate;
}

/** "$1.2K" for an XNO raw amount, or "" while the rate is unknown. */
export function fmtUsd(xnoRaw: string | undefined, rate: number | null): string {
  if (rate == null || !xnoRaw) return "";
  const n = (Number(BigInt(xnoRaw)) / 1e30) * rate;
  if (!Number.isFinite(n)) return "";
  return "$" + fmtNum(n);
}
