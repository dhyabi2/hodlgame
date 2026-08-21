// Derived status surfaces (docs/GROWTH-MECHANICS.md §4). Everything here is a
// pure function of the already-replayed market state — no new on-chain writes,
// no admin input. Any third party recomputes the identical ranks from the same
// public token views, so status is earned and verifiable, never decreed.

import type { TokenView } from "./market";

export interface TokenRank {
  tokenId: string;
  name: string;
  symbol: string;
  image: string;
  price: string;
  marketCap: string;
  change24h: number | null;
  holders: number;
  volume: string; // buy + sell, raw XNO
  createdAt: number;
}

export interface CreatorRank {
  account: string;
  tokenCount: number;
  holders: number; // summed across their tokens
  marketCap: string; // summed, raw XNO
  volume: string; // summed, raw XNO
  score: number;
  badges: string[];
  topSymbols: string[];
}

export interface HolderRank {
  account: string;
  tokensHeld: number;
  value: string; // summed holdings value, raw XNO
  badges: string[];
}

export interface Leaderboards {
  updatedAt: number;
  tokens: {
    byVolume: TokenRank[];
    byGainers: TokenRank[];
    byHolders: TokenRank[];
    newest: TokenRank[];
  };
  creators: CreatorRank[];
  holders: HolderRank[];
}

const vol = (t: TokenView) => BigInt(t.buyVolume) + BigInt(t.sellVolume);
const toXno = (raw: bigint) => Number(raw) / 1e30;

function toRank(t: TokenView): TokenRank {
  return {
    tokenId: t.tokenId,
    name: t.name,
    symbol: t.symbol,
    image: t.image,
    price: t.price,
    marketCap: t.marketCap,
    change24h: t.change24h,
    holders: t.holders,
    volume: vol(t).toString(),
    createdAt: t.createdAt,
  };
}

// Stable descending sort by a bigint key, tie-broken by tokenId so the order is
// deterministic (equal keys never reorder run-to-run).
function byBig(sel: (t: TokenView) => bigint) {
  return (a: TokenView, b: TokenView) => {
    const da = sel(a), db = sel(b);
    if (da !== db) return db > da ? 1 : -1;
    return a.tokenId < b.tokenId ? -1 : 1;
  };
}

// Redeemable XNO for selling `bal` tokens into the pool right now (constant
// product, no fee) — the honest, manipulation-resistant notion of "value". A
// fake-high mark price on a dry pool redeems to almost nothing, so it can't be
// used to fake a whale; value can never exceed what the pool could actually pay.
function redeemable(bal: bigint, poolXno: bigint, poolTokens: bigint): bigint {
  if (bal <= 0n || poolXno <= 0n || poolTokens <= 0n) return 0n;
  return (bal * poolXno) / (poolTokens + bal);
}
// Distinct trader accounts in the recent window — a wash-resistant activity
// signal: a single account looping buy/sell can't raise this, unlike raw volume.
function traders(t: TokenView): number {
  return new Set((t.trades ?? []).map((x: any) => x.account)).size;
}
// Holders that actually hold value — dust-sybil resistant: a 1-raw account is
// never in a token's top-holders set, so ranking by these ignores dust crowds.
// (The raw holders count is still shown as a stat, but not what boards rank on.)
function sigHolders(t: TokenView): number {
  const px = BigInt(t.poolXno), pt = BigInt(t.poolTokens);
  return t.topHolders.filter((h) => h.account !== t.pool && redeemable(BigInt(h.balanceRaw), px, pt) > 0n).length;
}

export function computeLeaderboards(tokens: TokenView[], nowMs: number, limit = 10): Leaderboards {
  const live = tokens.filter((t) => t.symbol || t.name);
  // Economic boards rank only tokens with real liquidity — a token with an empty
  // pool is free to spin up and dust-inflate, so it must not be rankable. Its
  // holdings also redeem to ~0, which the value math already reflects.
  const funded = live.filter((t) => BigInt(t.poolXno) > 0n);

  // Volume board ordered by DISTINCT traders first (wash-resistant), then volume.
  const byVolume = [...funded]
    .sort((a, b) => (traders(b) - traders(a)) || (vol(b) > vol(a) ? 1 : vol(b) < vol(a) ? -1 : a.tokenId < b.tokenId ? -1 : 1))
    .slice(0, limit).map(toRank);
  const byHolders = [...funded]
    .sort((a, b) => (sigHolders(b) - sigHolders(a)) || (b.holders - a.holders) || (a.tokenId < b.tokenId ? -1 : 1))
    .slice(0, limit).map(toRank);
  const byGainers = [...funded]
    .filter((t) => t.change24h != null)
    .sort((a, b) => ((b.change24h ?? -1e9) - (a.change24h ?? -1e9)) || (a.tokenId < b.tokenId ? -1 : 1))
    .slice(0, limit)
    .map(toRank);
  // "New" lists recent FUNDED launches only — an unseeded (zero-pool) token is
  // untradeable and free to spam, so it must not occupy discovery space either.
  const newest = [...funded].sort((a, b) => (b.createdAt - a.createdAt) || (a.tokenId < b.tokenId ? -1 : 1)).slice(0, limit).map(toRank);

  // ── creators: aggregate every token a launcher created ────────────────────
  // Sized by REAL pooled XNO (capital that actually exists), never mark-to-market
  // market cap — so a fake price on a dry pool contributes nothing to the score.
  const cmap = new Map<string, { count: number; holders: number; liq: bigint; volume: bigint; syms: string[] }>();
  for (const t of funded) {
    if (!t.creator) continue;
    const e = cmap.get(t.creator) ?? { count: 0, holders: 0, liq: 0n, volume: 0n, syms: [] };
    e.count++; e.holders += t.holders; e.liq += BigInt(t.poolXno); e.volume += vol(t);
    if (e.syms.length < 4 && t.symbol) e.syms.push(t.symbol);
    cmap.set(t.creator, e);
  }
  const maxLiq = [...cmap.values()].reduce((m, e) => (e.liq > m ? e.liq : m), 0n);
  const creators: CreatorRank[] = [...cmap.entries()]
    .map(([account, e]) => {
      const badges: string[] = [];
      if (e.count >= 3) badges.push("🚀 Serial");
      if (e.holders >= 25) badges.push("👥 Community");
      if (maxLiq > 0n && e.liq === maxLiq) badges.push("💎 Blue Chip");
      // deterministic integer score: holders, breadth, then REAL liquidity in XNO
      const score = e.holders * 100 + e.count * 50 + Math.round(toXno(e.liq));
      return { account, tokenCount: e.count, holders: e.holders, marketCap: e.liq.toString(), volume: e.volume.toString(), score, badges, topSymbols: e.syms };
    })
    .sort((a, b) => (b.score - a.score) || (a.account < b.account ? -1 : 1))
    .slice(0, limit);

  // ── holders: aggregate surfaced top-holders by REDEEMABLE value ───────────
  const hmap = new Map<string, { value: bigint; tokens: number }>();
  for (const t of funded) {
    const poolXno = BigInt(t.poolXno), poolTokens = BigInt(t.poolTokens);
    for (const h of t.topHolders) {
      if (h.account === t.pool) continue; // never rank a pool account as a holder
      const value = redeemable(BigInt(h.balanceRaw), poolXno, poolTokens);
      if (value <= 0n) continue;
      const e = hmap.get(h.account) ?? { value: 0n, tokens: 0 };
      e.value += value; e.tokens++;
      hmap.set(h.account, e);
    }
  }
  const holderArr = [...hmap.entries()].sort((a, b) => (b[1].value > a[1].value ? 1 : b[1].value < a[1].value ? -1 : a[0] < b[0] ? -1 : 1));
  const holders: HolderRank[] = holderArr.slice(0, limit).map(([account, e], i) => {
    const badges: string[] = [];
    if (i === 0) badges.push("🐋 Whale");
    if (e.tokens >= 3) badges.push("🌈 Diversified");
    return { account, tokensHeld: e.tokens, value: e.value.toString(), badges };
  });

  return { updatedAt: nowMs, tokens: { byVolume, byGainers, byHolders, newest }, creators, holders };
}

/** Reputation score + badges for one creator (surfaced on a token page). Same
 * derivation as the creators leaderboard, scoped to one account. */
export function creatorReputation(tokens: TokenView[], account: string): CreatorRank | null {
  if (!account) return null;
  const board = computeLeaderboards(tokens, 0, 10_000).creators;
  return board.find((c) => c.account === account) ?? null;
}
