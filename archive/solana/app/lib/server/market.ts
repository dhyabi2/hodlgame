import { PublicKey } from "@solana/web3.js";
import {
  listTokens,
  serverConnection,
  getPriceHistory,
} from "./chain";

/**
 * Market stats (24h price change) reconstructed entirely from on-chain swap
 * events — no indexer or external storage needed. A constant-product pool's
 * price only ever changes when a swap happens, so the swap history *is* the
 * price history.
 */

const DAY = 24 * 3600;

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
    if (t.priceSol !== null) {
      try {
        const history = await getPriceHistory(
          connection,
          new PublicKey(t.mint),
          t.decimals,
          200
        );
        // The first swap at or before 24h ago is our reference price.
        for (const p of history) {
          if (now - p.time >= DAY) {
            if (p.price > 0) {
              change24hPct = ((t.priceSol - p.price) / p.price) * 100;
            }
            break;
          }
        }
      } catch {
        change24hPct = null;
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
