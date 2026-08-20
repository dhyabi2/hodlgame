// Pure token analytics derived from the deterministic op replay: price, market
// cap, holders, a price/time series (for charts), and a trade feed. No network.

import { applyBlock, multiEmpty, type MultiState } from "../core/multi";
import type { IndexedEvent } from "../indexer/multiIndexer";

export interface Holder {
  account: string;
  balanceRaw: string;
  pct: number; // percent of supply, 0..100
}

export interface TradeEvent {
  kind: "buy" | "sell";
  account: string;
  amountRaw: string;
  priceRaw: string;
  time: number;
}

export interface PricePoint {
  time: number; // epoch seconds (or height fallback)
  priceRaw: string;
  marketCapRaw: string;
}

export interface TokenAnalytics {
  tokenId: string;
  priceRaw: string; // XNO raw per whole token
  marketCapRaw: string; // XNO raw
  supplyRaw: string;
  poolXno: string;
  poolTokens: string;
  holders: Holder[];
  trades: TradeEvent[];
  series: PricePoint[];
  buyVolumeRaw: string;
  sellVolumeRaw: string;
}

/** XNO-raw price of one whole token. */
export function priceOf(poolXno: bigint, poolTokens: bigint, decimals: number): bigint {
  if (poolTokens <= 0n) return 0n;
  return (poolXno * 10n ** BigInt(decimals)) / poolTokens;
}

export function marketCapOf(priceRaw: bigint, supply: bigint, decimals: number): bigint {
  return (priceRaw * supply) / 10n ** BigInt(decimals);
}

export interface SellPayout {
  tokenId: string;
  to: string; // seller (recipient of XNO)
  amountRaw: bigint; // exact XNO-out at the sell's execution point
  hash: string; // sell block hash (idempotency key)
}

export interface Analytics {
  state: MultiState;
  byToken: Map<string, TokenAnalytics>;
  sellPayouts: SellPayout[];
}

export function analyze(events: IndexedEvent[]): Analytics {
  let s = multiEmpty();
  const seriesMap = new Map<string, PricePoint[]>();
  const lastTimeMap = new Map<string, number>();
  const sellPayouts: SellPayout[] = [];
  const tradesMap = new Map<string, TradeEvent[]>();
  const buyVol = new Map<string, bigint>();
  const sellVol = new Map<string, bigint>();

  const timeFor = (tokenId: string, ev: IndexedEvent): number => {
    const t = ev.timestamp ?? Number(ev.height);
    const last = lastTimeMap.get(tokenId) ?? 0;
    const time = t > last ? t : last + 1; // enforce strictly-monotonic xs
    lastTimeMap.set(tokenId, time);
    return time;
  };

  for (const ev of events) {
    let out: bigint | null = null;
    if (ev.op.kind === "sell") {
      const pre = s.get(ev.tokenId);
      if (pre && pre.poolXno > 0n && pre.poolTokens > 0n) {
        out = (ev.op.tokens * pre.poolXno) / (pre.poolTokens + ev.op.tokens);
      }
    }

    let next;
    try {
      next = applyBlock(s, ev);
    } catch {
      continue;
    }
    s = next;
    const st = s.get(ev.tokenId);
    if (!st) continue;

    // Exact XNO-out computed at the sell's execution point (pre-sell reserves),
    // so a batch of sells is paid path-dependently, not against final reserves.
    if (out !== null) {
      sellPayouts.push({ tokenId: ev.tokenId, to: ev.sender, amountRaw: out, hash: ev.hash });
    }

    if ((ev.op.kind === "buy" || ev.op.kind === "sell" || ev.op.kind === "seedLiq" || ev.op.kind === "addLiq") && st.poolTokens > 0n) {
      const price = priceOf(st.poolXno, st.poolTokens, st.decimals);
      const mc = marketCapOf(price, st.supply, st.decimals);
      const time = timeFor(ev.tokenId, ev);
      const arr = seriesMap.get(ev.tokenId) ?? [];
      arr.push({ time, priceRaw: price.toString(), marketCapRaw: mc.toString() });
      seriesMap.set(ev.tokenId, arr);
    }

    if (ev.op.kind === "buy") {
      const price = priceOf(st.poolXno, st.poolTokens, st.decimals);
      const t = tradesMap.get(ev.tokenId) ?? [];
      t.push({ kind: "buy", account: ev.sender, amountRaw: ev.op.xno.toString(), priceRaw: price.toString(), time: timeFor(ev.tokenId, ev) });
      tradesMap.set(ev.tokenId, t);
      buyVol.set(ev.tokenId, (buyVol.get(ev.tokenId) ?? 0n) + ev.op.xno);
    } else if (ev.op.kind === "sell") {
      const price = priceOf(st.poolXno, st.poolTokens, st.decimals);
      const t = tradesMap.get(ev.tokenId) ?? [];
      t.push({ kind: "sell", account: ev.sender, amountRaw: ev.op.tokens.toString(), priceRaw: price.toString(), time: timeFor(ev.tokenId, ev) });
      tradesMap.set(ev.tokenId, t);
      sellVol.set(ev.tokenId, (sellVol.get(ev.tokenId) ?? 0n) + ev.op.tokens);
    }
  }

  const byToken = new Map<string, TokenAnalytics>();
  for (const [tokenId, st] of s) {
    if (!st.launched) continue;
    const price = priceOf(st.poolXno, st.poolTokens, st.decimals);
    const mc = marketCapOf(price, st.supply, st.decimals);
    const holders: Holder[] = [...st.balances]
      .map(([account, bal]) => ({
        account,
        balanceRaw: bal.toString(),
        pct: st.supply > 0n ? Number((bal * 10000n) / st.supply) / 100 : 0,
      }))
      .sort((a, b) => (BigInt(b.balanceRaw) > BigInt(a.balanceRaw) ? 1 : -1));

    byToken.set(tokenId, {
      tokenId,
      priceRaw: price.toString(),
      marketCapRaw: mc.toString(),
      supplyRaw: st.supply.toString(),
      poolXno: st.poolXno.toString(),
      poolTokens: st.poolTokens.toString(),
      holders,
      trades: (tradesMap.get(tokenId) ?? []).slice(-100).reverse(),
      series: seriesMap.get(tokenId) ?? [],
      buyVolumeRaw: (buyVol.get(tokenId) ?? 0n).toString(),
      sellVolumeRaw: (sellVol.get(tokenId) ?? 0n).toString(),
    });
  }

  return { state: s, byToken, sellPayouts };
}