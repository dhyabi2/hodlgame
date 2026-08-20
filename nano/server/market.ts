// Market presentation layer: enrich the deterministic multi-token state with
// analytics (price/market-cap/holders/trades/series), off-chain metadata, and
// per-token pool addresses.

import { MultiIndexer } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { analyze, type PricePoint, type TokenAnalytics } from "./analytics";
import { tokenPoolKeys } from "./custody";
import { loadRegistry, EMPTY_META } from "./tokens";
import { commentsFor, type Comment } from "./comments";
import { loadNanoRpcKey } from "../lib/rpc";

export interface TokenView {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  creator: string;
  creatorShare: string;
  supply: string;
  poolXno: string;
  poolTokens: string;
  price: string;
  marketCap: string;
  buyVolume: string;
  sellVolume: string;
  holders: number;
  pool: string | null;
  spark: PricePoint[];
  series: PricePoint[];
  trades: TokenAnalytics["trades"];
  topHolders: TokenAnalytics["holders"];
  comments: Comment[];
}

function watched(): string[] {
  return (process.env.WATCHED_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface RawMarket {
  state: ReturnType<typeof analyze>["state"];
  byToken: Map<string, TokenAnalytics>;
  meta: Map<string, any>;
  master: string;
}

async function compute(): Promise<RawMarket> {
  const reg = loadRegistry();
  const idx = new MultiIndexer(new NanoRpcSource(loadNanoRpcKey()), (id) => reg.get(id) ?? EMPTY_META);
  const events = await idx.collectEvents(watched());
  const { state, byToken } = analyze(events);
  return { state, byToken, meta: reg, master: process.env.POOL_SEED ?? "" };
}

function toView(tokenId: string, a: TokenAnalytics, raw: RawMarket): TokenView {
  const meta = raw.meta.get(tokenId) ?? EMPTY_META;
  const s = raw.state.get(tokenId);
  return {
    tokenId,
    name: meta.name ?? "",
    symbol: meta.symbol ?? "",
    decimals: meta.decimals ?? 6,
    image: meta.image ?? "",
    description: meta.description ?? "",
    website: meta.website ?? "",
    twitter: meta.twitter ?? "",
    telegram: meta.telegram ?? "",
    creator: s?.creator ?? "",
    creatorShare: s?.creatorShare.toString() ?? "0",
    supply: a.supplyRaw,
    poolXno: a.poolXno,
    poolTokens: a.poolTokens,
    price: a.priceRaw,
    marketCap: a.marketCapRaw,
    buyVolume: a.buyVolumeRaw,
    sellVolume: a.sellVolumeRaw,
    holders: a.holders.length,
    pool: raw.master ? tokenPoolKeys(raw.master, tokenId).address : null,
    spark: a.series.slice(-48),
    series: a.series,
    trades: a.trades,
    topHolders: a.holders,
    comments: commentsFor(tokenId),
  };
}

/** Feed view: all tokens, trimmed (spark only, no full series/trades). */
export async function feed(): Promise<TokenView[]> {
  const raw = await compute();
  const out: TokenView[] = [];
  for (const [tokenId, a] of raw.byToken) {
    const v = toView(tokenId, a, raw);
    v.series = [];
    v.trades = [];
    v.topHolders = [];
    v.comments = [];
    out.push(v);
  }
  return out.sort((x, y) => (BigInt(y.marketCap) > BigInt(x.marketCap) ? 1 : -1));
}

/** Detail view: a single token with full series, trades, holders, comments. */
export async function detail(tokenId: string): Promise<TokenView | null> {
  const raw = await compute();
  const a = raw.byToken.get(tokenId);
  if (!a) return null;
  return toView(tokenId, a, raw);
}