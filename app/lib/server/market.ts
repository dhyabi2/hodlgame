import { kv } from "@vercel/kv";
import { listTokens, serverConnection, type TokenStats } from "./chain";

/**
 * Price history for the 24h performance figure, stored in Vercel KV.
 *
 * The cron job calls `snapshotPrices()` every few minutes; it records each
 * token's current price in a per-mint list and trims it to a ~25h window.
 * `marketStats()` reads the oldest surviving snapshot (>= 24h ago) to compute
 * the 24h price change.
 */

const DAY = 24 * 3600;
const KEEP = 150; // 10-min interval → ~25h of history
const snapKey = (mint: string) => `snap:${mint}`;

export function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/** Record the current price of every live token. Returns snapshots written. */
export async function snapshotPrices(): Promise<number> {
  if (!kvConfigured()) return 0;
  const connection = serverConnection();
  const tokens = await listTokens(connection);
  const now = Math.floor(Date.now() / 1000);

  let written = 0;
  for (const t of tokens) {
    if (t.priceSol === null) continue;
    await kv.lpush(snapKey(t.mint), JSON.stringify({ t: now, p: t.priceSol }));
    await kv.ltrim(snapKey(t.mint), 0, KEEP - 1);
    await kv.expire(snapKey(t.mint), DAY + 3600);
    written++;
  }
  return written;
}

export interface MarketStat {
  priceSol: number | null;
  marketCapSol: number | null;
  change24hPct: number | null;
}

export async function marketStats(): Promise<Record<string, MarketStat>> {
  const connection = serverConnection();
  const tokens = await listTokens(connection);
  const now = Math.floor(Date.now() / 1000);

  const out: Record<string, MarketStat> = {};
  for (const t of tokens) {
    let change24hPct: number | null = null;
    if (kvConfigured() && t.priceSol !== null) {
      const snaps = await kv.lrange<string>(snapKey(t.mint), 0, -1);
      for (const raw of snaps) {
        let s: { t: number; p: number };
        try {
          s = JSON.parse(raw);
        } catch {
          continue;
        }
        if (now - s.t >= DAY) {
          if (s.p > 0) change24hPct = ((t.priceSol - s.p) / s.p) * 100;
          break;
        }
      }
    }
    out[t.mint] = {
      priceSol: t.priceSol,
      marketCapSol: t.marketCapSol,
      change24hPct,
    };
  }
  return out;
}

/** Exported for completeness — the cron caller only needs snapshotPrices. */
export type { TokenStats };
