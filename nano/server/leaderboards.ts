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

export function computeLeaderboards(tokens: TokenView[], nowMs: number, limit = 10): Leaderboards {
  const live = tokens.filter((t) => t.symbol || t.name);

  const byVolume = [...live].sort(byBig(vol)).slice(0, limit).map(toRank);
  const byHolders = [...live].sort((a, b) => (b.holders - a.holders) || (a.tokenId < b.tokenId ? -1 : 1)).slice(0, limit).map(toRank);
  const byGainers = [...live]
    .filter((t) => t.change24h != null)
    .sort((a, b) => ((b.change24h ?? -1e9) - (a.change24h ?? -1e9)) || (a.tokenId < b.tokenId ? -1 : 1))
    .slice(0, limit)
    .map(toRank);
  const newest = [...live].sort((a, b) => (b.createdAt - a.createdAt) || (a.tokenId < b.tokenId ? -1 : 1)).slice(0, limit).map(toRank);

  // ── creators: aggregate every token a launcher created ────────────────────
  const cmap = new Map<string, { count: number; holders: number; mcap: bigint; volume: bigint; syms: string[] }>();
  for (const t of live) {
    if (!t.creator) continue;
    const e = cmap.get(t.creator) ?? { count: 0, holders: 0, mcap: 0n, volume: 0n, syms: [] };
    e.count++; e.holders += t.holders; e.mcap += BigInt(t.marketCap); e.volume += vol(t);
    if (e.syms.length < 4 && t.symbol) e.syms.push(t.symbol);
    cmap.set(t.creator, e);
  }
  const maxMcap = [...cmap.values()].reduce((m, e) => (e.mcap > m ? e.mcap : m), 0n);
  const creators: CreatorRank[] = [...cmap.entries()]
    .map(([account, e]) => {
      const badges: string[] = [];
      if (e.count >= 3) badges.push("🚀 Serial");
      if (e.holders >= 25) badges.push("👥 Community");
      if (maxMcap > 0n && e.mcap === maxMcap) badges.push("💎 Blue Chip");
      // deterministic integer score: holders dominate, then breadth, then size
      const score = e.holders * 100 + e.count * 50 + Math.round(toXno(e.mcap));
      return { account, tokenCount: e.count, holders: e.holders, marketCap: e.mcap.toString(), volume: e.volume.toString(), score, badges, topSymbols: e.syms };
    })
    .sort((a, b) => (b.score - a.score) || (a.account < b.account ? -1 : 1))
    .slice(0, limit);

  // ── holders: aggregate the top holders surfaced per token by value ────────
  const hmap = new Map<string, { value: bigint; tokens: number }>();
  for (const t of live) {
    const price = BigInt(t.price);
    const denom = 10n ** BigInt(t.decimals);
    for (const h of t.topHolders) {
      if (h.account === t.pool) continue; // never rank a pool account as a holder
      const value = (BigInt(h.balanceRaw) * price) / denom;
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
