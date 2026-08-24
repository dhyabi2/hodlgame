// Pure token analytics derived from the deterministic op replay: price, market
// cap, holders, a price/time series (for charts), and a trade feed. No network.

import { applyBlock, multiEmpty, type MultiState } from "../core/multi";
import { fixpointOrder } from "../indexer/replay";
import type { IndexedEvent } from "../indexer/multiIndexer";
import { clampDecimals } from "./validate";

export interface Holder {
  account: string;
  balanceRaw: string; // liquid (unstaked) balance
  stakedRaw: string; // staked portion — still theirs, still a holding
  pct: number; // percent of supply held (liquid + staked), 0..100
}

export interface TradeEvent {
  kind: "buy" | "sell";
  account: string;
  amountRaw: string;
  priceRaw: string;
  /** XNO actually exchanged (raw): what a buy PAID / what a sell realized.
   * The UI must show this, never amountRaw × post-trade price — on a thin
   * pool a buy moves its own price so far that the mark-to-market read
   * "99.9 XNO" for a 1 XNO buy (user report, 2026-08-24). */
  xnoRaw: string;
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
  launchTime: number; // epoch seconds (or height fallback) at launch
  holders: Holder[];
  trades: TradeEvent[];
  series: PricePoint[];
  buyVolumeRaw: string;
  sellVolumeRaw: string;
}

/** XNO-raw price of one whole token. */
export function priceOf(poolXno: bigint, poolTokens: bigint, decimals: number): bigint {
  if (poolTokens <= 0n) return 0n;
  return (poolXno * 10n ** BigInt(clampDecimals(decimals))) / poolTokens;
}

export function marketCapOf(priceRaw: bigint, supply: bigint, decimals: number): bigint {
  return (priceRaw * supply) / 10n ** BigInt(clampDecimals(decimals));
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
  const launchTime = new Map<string, number>();
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

  // Fold in the deterministic FIXPOINT application order (indexer/replay.ts)
  // so analytics and consensus state can never disagree about which events
  // applied or in what sequence.
  const { applied } = fixpointOrder(events);
  for (const ev of applied) {
    const pre = s.get(ev.tokenId);
    let out: bigint | null = null; // XNO-out for on-chain pool payout (non-direct sells only)
    let sellXno: bigint | null = null; // XNO value of a sell for VOLUME/tape (any pooled or virtual token)
    if (ev.op.kind === "sell" && pre && pre.poolXno > 0n && pre.poolTokens > 0n) {
      sellXno = (ev.op.tokens * pre.poolXno) / (pre.poolTokens + ev.op.tokens);
      // Direct tokens never produce pool payouts — sells settle wallet-side
      // (earmark release + flow queue), so no SellPayout entry is emitted.
      if (!pre.direct) out = sellXno;
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

    if (ev.op.kind === "launch") {
      launchTime.set(ev.tokenId, ev.timestamp ?? Number(ev.height));
    }

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
      // Trade "size" is TOKENS for both buy and sell, so the shared display
      // formula amountRaw·price/10^dec (and the fmtTok column) is correct. A
      // buy's tokens received = pre.poolTokens − post.poolTokens.
      const tokensGot = pre ? pre.poolTokens - st.poolTokens : 0n;
      const t = tradesMap.get(ev.tokenId) ?? [];
      t.push({ kind: "buy", account: ev.sender, amountRaw: tokensGot.toString(), priceRaw: price.toString(), xnoRaw: ev.op.xno.toString(), time: timeFor(ev.tokenId, ev) });
      tradesMap.set(ev.tokenId, t);
      // Volume in XNO-raw (the value spent) so buy and sell volume share units.
      buyVol.set(ev.tokenId, (buyVol.get(ev.tokenId) ?? 0n) + ev.op.xno);
    } else if (ev.op.kind === "sell") {
      const price = priceOf(st.poolXno, st.poolTokens, st.decimals);
      const t = tradesMap.get(ev.tokenId) ?? [];
      t.push({ kind: "sell", account: ev.sender, amountRaw: ev.op.tokens.toString(), priceRaw: price.toString(), xnoRaw: (sellXno ?? 0n).toString(), time: timeFor(ev.tokenId, ev) });
      tradesMap.set(ev.tokenId, t);
      // Volume in XNO-raw (value received) so it matches buyVolume's units;
      // was token-raw, which made buy+sell volume meaningless to sum/rank.
      sellVol.set(ev.tokenId, (sellVol.get(ev.tokenId) ?? 0n) + (sellXno ?? 0n));
    }
  }

  const byToken = new Map<string, TokenAnalytics>();
  for (const [tokenId, st] of s) {
    if (!st.launched) continue;
    const price = priceOf(st.poolXno, st.poolTokens, st.decimals);
    const mc = marketCapOf(price, st.supply, st.decimals);
    // A holding = liquid balance + staked. Staking moves tokens out of
    // `balances`, so a balances-only list made every fully-staked holder
    // vanish (and undercounted holders / percentages). Zero-position
    // accounts (sold out, fully transferred) are not holders.
    const accounts = new Set([...st.balances.keys(), ...st.staked.keys()]);
    const holders: Holder[] = [...accounts]
      .map((account) => {
        const bal = st.balances.get(account) ?? 0n;
        const stk = st.staked.get(account) ?? 0n;
        const total = bal + stk;
        return {
          account,
          balanceRaw: bal.toString(),
          stakedRaw: stk.toString(),
          pct: st.supply > 0n ? Number((total * 10000n) / st.supply) / 100 : 0,
          total,
        };
      })
      .filter((h) => h.total > 0n)
      .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.account < b.account ? -1 : 1))
      .map(({ total: _t, ...h }) => h);

    byToken.set(tokenId, {
      tokenId,
      priceRaw: price.toString(),
      marketCapRaw: mc.toString(),
      supplyRaw: st.supply.toString(),
      poolXno: st.poolXno.toString(),
      poolTokens: st.poolTokens.toString(),
      launchTime: launchTime.get(tokenId) ?? 0,
      holders,
      trades: (tradesMap.get(tokenId) ?? []).slice(-100).reverse(),
      series: seriesMap.get(tokenId) ?? [],
      buyVolumeRaw: (buyVol.get(tokenId) ?? 0n).toString(),
      sellVolumeRaw: (sellVol.get(tokenId) ?? 0n).toString(),
    });
  }

  return { state: s, byToken, sellPayouts };
}