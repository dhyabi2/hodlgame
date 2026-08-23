// Server-side XNO→USD rate. CoinGecko's free API rate-limits by IP and blocks
// cross-origin browser calls, so instead of every visitor hitting it (getting
// 429s / CORS errors), the server fetches it ONCE per interval — refreshed by
// the cron — stores it in the durable store, and serves the stored value to all
// clients via /api/xno-usd. One upstream call per interval, not one per user.

import { saveBlob, loadBlob } from "./store";

const KEY = "xno-usd";
const FRESH_MS = 2 * 60_000; // serve in-memory without touching the store
const STALE_MS = 20 * 60_000; // beyond this, refresh on-demand even if a value exists

let mem: { rate: number; at: number } | null = null;

/** Fetch the live rate from CoinGecko and persist it. Returns null on failure
 * (callers keep the last known value). Server-side, so no CORS / browser limit. */
export async function refreshXnoUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=nano&vs_currencies=usd", {
      headers: { accept: "application/json" },
      // never let a slow upstream stall the caller
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    const rate = Number(j?.nano?.usd);
    if (Number.isFinite(rate) && rate > 0) {
      mem = { rate, at: Date.now() };
      await saveBlob(KEY, JSON.stringify(mem)).catch(() => {});
      return rate;
    }
  } catch {}
  return null;
}

/** The current rate for the client — from memory, then the store, refreshing
 * on demand only if what we have is stale. Never throws; degrades to null. */
export async function getXnoUsd(): Promise<{ rate: number | null; at: number | null; source: string }> {
  const now = Date.now();
  if (mem && now - mem.at < FRESH_MS) return { rate: mem.rate, at: mem.at, source: "mem" };
  try {
    const raw = await loadBlob(KEY);
    if (raw) {
      const p = JSON.parse(raw) as { rate: number; at: number };
      if (Number.isFinite(p?.rate) && p.rate > 0) {
        mem = p;
        if (now - p.at < STALE_MS) return { rate: p.rate, at: p.at, source: "store" };
      }
    }
  } catch {}
  // Stale or missing → refresh on demand (also primes before the first cron run).
  const rate = await refreshXnoUsd();
  if (rate != null && mem) return { rate: mem.rate, at: mem.at, source: "fetch" };
  return mem ? { rate: mem.rate, at: mem.at, source: "stale" } : { rate: null, at: null, source: "none" };
}
