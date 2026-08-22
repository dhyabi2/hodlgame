// Market presentation layer: enrich the deterministic multi-token state with
// analytics (price/market-cap/holders/trades/series), off-chain metadata, and
// per-token pool addresses.

import { MultiIndexer, type IndexedEvent } from "../indexer/multiIndexer";
import { deriveAddress } from "nanocurrency";
import { NanoRpcSource } from "../indexer/blockSource";
import { analyze, type PricePoint, type TokenAnalytics } from "./analytics";
import { tokenPoolKeys } from "./custody";
import { loadRegistry, EMPTY_META } from "./tokens";
import { commentsFor, type Comment } from "./comments";
import { commitResolver } from "./commits";
import { loadNanoRpcKey } from "../lib/rpc";
import { watchedAccounts } from "./operator";
import { deriveMetaAuthority, type MetaAuthorityState } from "../core/metaAnchor";
import { claimableReward } from "../core/state";

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
  treasury: string;
  poolXno: string;
  poolTokens: string;
  price: string;
  marketCap: string;
  change1h: number | null;
  change24h: number | null;
  createdAt: number;
  myBalance: string;
  myCredit: string; // in-game XNO credit from sells (raw) — withdrawable
  // ── Direct-Settlement (zero-custody) surface ──────────────────────────────
  direct: boolean;
  myEarmark: string; // my remaining self-collateral (raw XNO, in MY wallet)
  myFloor: string; // ratcheted balance floor I must keep on-chain (raw)
  myQueueOwed: string; // my queued flow-backed claim total (raw)
  myPrepaid: string; // XNO buys already overpaid me (nets my next sell)
  queueTotal: string; // all outstanding flow-backed claims (raw)
  totalFloor: string; // sum of all ratcheted earmark floors (raw) — coverage numerator
  queueHead: { account: string; owedRaw: string } | null; // next seller a buy must pay
  coveragePct: number | null; // floored collateral of all holders / claims, %
  myStaked: string;
  myClaimable: string;
  totalStaked: string;
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

export interface RawMarket {
  state: ReturnType<typeof analyze>["state"];
  byToken: Map<string, TokenAnalytics>;
  meta: Map<string, any>;
  master: string;
  metaAuthority: Map<string, MetaAuthorityState>;
  events: IndexedEvent[];
  idx: MultiIndexer;
  sellPayouts: ReturnType<typeof analyze>["sellPayouts"];
}

// Deliberately UNCACHED. This used to be a 2-second in-memory cache shared
// by burst requests (feed + detail + SSE) on one warm instance — but on
// Vercel each serverless instance has its own isolated memory, so two
// requests landing on different instances could already disagree for up to
// 2 seconds, and every write path (see the deleted bustCache()) needed a
// manual "did I remember to invalidate the cache" call to stay correct. That
// class of bug is exactly what made a freshly-launched coin intermittently
// vanish from the feed (see operator.ts's watchedAccounts() for the full
// story) — same root cause, smaller blast radius. Every call here replays
// live from chain data; there is nothing for a cache to save that isn't
// already a live, verified RPC round-trip away.
async function compute(): Promise<RawMarket> {
  const reg = await loadRegistry();
  const commit = await commitResolver();
  const master = process.env.POOL_SEED ?? "";
  const poolKey = (tokenId: string) => (master ? tokenPoolKeys(master, tokenId).publicKey : null);
  const src = new NanoRpcSource(loadNanoRpcKey());
  const idx = new MultiIndexer(src, (id) => reg.get(id) ?? EMPTY_META, commit, poolKey);
  const watched = await watchedAccounts();
  let events = await idx.collectEvents(watched);
  // Second discovery pass: a creator's chain reveals each token's pool (the
  // seed-deposit link), even before the pool's own anchor hello lands — that
  // hello is only broadcast by the sweep cron, and only once the pool is
  // opened. Scanning those pools' counterparties (confirmed AND pending)
  // catches a first-time buyer whose only on-chain activity is deposit+buy,
  // so their holdings appear immediately instead of after the next sweep.
  const watchedSet = new Set(watched);
  const extra = new Set<string>();
  for (const set of idx.getChainPoolSet().values()) {
    for (const pub of set) {
      const cp = await src.counterparties(deriveAddress(pub, { useNanoPrefix: true })).catch(() => null);
      if (!cp) continue;
      for (const h of cp.inbound) if (!watchedSet.has(h.sender)) extra.add(h.sender);
    }
  }
  if (extra.size > 0) events = await idx.collectEvents([...watchedSet, ...extra].sort());
  const { state, byToken, sellPayouts } = analyze(events);
  // Chain-derived metadata-authority state (core/metaAnchor.ts): seeded by
  // each launch creator, folded over on-chain immutable/setAuthority anchors.
  const creators = new Map<string, string>();
  for (const [tokenId, s] of state) if (s.creator) creators.set(tokenId, s.creator);
  const metaAuthority = deriveMetaAuthority(idx.getMetaAnchors(), creators);
  return { state, byToken, meta: reg, master, metaAuthority, events, idx, sellPayouts };
}

/** On-chain creator for a token (launch block signer), or null if the launch
 * isn't indexed yet / the RPC is unreachable. Used as the metadata authority. */
export async function creatorOf(tokenId: string): Promise<string | null> {
  try {
    const { state } = await compute();
    return state.get(tokenId)?.creator || null;
  } catch {
    return null;
  }
}

/** Chain-derived metadata-authority state for a token (creator seeded, folded
 * over on-chain anchors), or null if the launch isn't indexed / RPC down. */
export async function authorityStateOf(tokenId: string): Promise<MetaAuthorityState | null> {
  try {
    const { metaAuthority } = await compute();
    return metaAuthority.get(tokenId) ?? null;
  } catch {
    return null;
  }
}

/** Raw market internals (events, indexer, payouts) for the explorer layer. */
export async function raw(): Promise<RawMarket> {
  return compute();
}

/** Percent change vs the last price at or before `now - secondsAgo` (step fn). */
function changePct(series: PricePoint[], secondsAgo: number): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const target = last.time - secondsAgo;
  let base = series[0];
  for (const p of series) {
    if (p.time >= target) {
      base = p;
      break;
    }
  }
  const cur = BigInt(last.priceRaw);
  const prev = BigInt(base.priceRaw);
  if (prev === 0n) return null;
  const bps = (cur - prev) * 10_000n / prev; // percent * 100
  const pct = Number(bps) / 100;
  return Number.isFinite(pct) ? pct : null;
}

async function toView(tokenId: string, a: TokenAnalytics, raw: RawMarket, account = "", withComments = true): Promise<TokenView> {
  const meta = raw.meta.get(tokenId) ?? EMPTY_META;
  const s = raw.state.get(tokenId);
  return {
    tokenId,
    name: meta.name ?? "",
    symbol: meta.symbol ?? "",
    // Decimals are consensus-bound at launch (immutable, on-chain). Prefer the
    // replayed state so a mutable metadata update can't change how the client
    // scales amounts (which would corrupt buy/sell/supply math). Fall back to
    // metadata only for legacy tokens whose launch didn't carry the byte.
    decimals: s?.decimals ?? meta.decimals ?? 6,
    image: meta.image ?? "",
    description: meta.description ?? "",
    website: meta.website ?? "",
    twitter: meta.twitter ?? "",
    telegram: meta.telegram ?? "",
    creator: s?.creator ?? "",
    creatorShare: s?.creatorShare.toString() ?? "0",
    supply: a.supplyRaw,
    treasury: s?.treasury.toString() ?? "0",
    poolXno: a.poolXno,
    poolTokens: a.poolTokens,
    price: a.priceRaw,
    marketCap: a.marketCapRaw,
    change1h: changePct(a.series, 3600),
    change24h: changePct(a.series, 86400),
    createdAt: a.launchTime,
    myBalance: account ? (a.holders.find((h) => h.account === account)?.balanceRaw ?? "0") : "0",
    myCredit: account && s ? (s.xnoCredit.get(account) ?? 0n).toString() : "0",
    direct: s?.direct ?? false,
    myEarmark: account && s ? (s.earmark.get(account) ?? 0n).toString() : "0",
    myFloor: account && s ? (s.earmarkFloor.get(account) ?? 0n).toString() : "0",
    myQueueOwed: account && s ? s.queue.filter((e) => e.account === account).reduce((t, e) => t + e.owed, 0n).toString() : "0",
    myPrepaid: account && s ? (s.prepaid.get(account) ?? 0n).toString() : "0",
    queueTotal: s ? s.queue.reduce((t, e) => t + e.owed, 0n).toString() : "0",
    // Sum of all ratcheted floors — the client mirrors the on-chain sell
    // haircut exactly (credited = min(rem, max(0, (totalFloor − myFloor) −
    // queueTotal))), so the preview never disagrees with execution.
    totalFloor: (() => { let f = 0n; if (s) for (const v of s.earmarkFloor.values()) f += v; return f.toString(); })(),
    queueHead: s?.queue.find((e) => e.owed > 0n)
      ? { account: s!.queue.find((e) => e.owed > 0n)!.account, owedRaw: s!.queue.find((e) => e.owed > 0n)!.owed.toString() }
      : null,
    coveragePct: (() => {
      if (!s?.direct) return null;
      const q = s.queue.reduce((t, e) => t + e.owed, 0n);
      if (q <= 0n) return 100;
      let f = 0n;
      for (const v of s.earmarkFloor.values()) f += v;
      const pct = Number((f * 10_000n) / q) / 100;
      return Number.isFinite(pct) ? Math.min(pct, 999) : null;
    })(),
    myStaked: account && s ? (s.staked.get(account)?.toString() ?? "0") : "0",
    myClaimable: account && s ? claimableReward(s, account).toString() : "0",
    totalStaked: s?.totalStaked.toString() ?? "0",
    buyVolume: a.buyVolumeRaw,
    sellVolume: a.sellVolumeRaw,
    holders: a.holders.length,
    // Direct tokens have no pool account — by design, forever.
    pool: s?.direct ? null : raw.master ? tokenPoolKeys(raw.master, tokenId).address : null,
    spark: a.series.slice(-48),
    series: a.series,
    trades: a.trades,
    topHolders: a.holders,
    // Skip the per-token comments blob read on list/ranks paths (they discard
    // it). Only the single-token detail view needs it.
    comments: withComments ? await commentsFor(tokenId) : [],
  };
}

/** Feed view: all tokens, trimmed (spark only, no full series/trades/comments). */
export async function feed(account = ""): Promise<TokenView[]> {
  const raw = await compute();
  const out: TokenView[] = [];
  for (const [tokenId, a] of raw.byToken) {
    const v = await toView(tokenId, a, raw, account, false);
    v.series = [];
    v.trades = [];
    v.topHolders = [];
    v.comments = [];
    out.push(v);
  }
  return out.sort((x, y) => (BigInt(y.marketCap) > BigInt(x.marketCap) ? 1 : -1));
}

/** Ranks view: like feed() but KEEPS topHolders + trades, which the leaderboards
 * derivation needs (the holders board and the wash-resistant volume/holders
 * boards read them). Drops only the heavy series + comments. Fixes the
 * always-empty "Top holders" board caused by feeding computeLeaderboards the
 * fully-stripped feed() payload. */
export async function ranksFeed(account = ""): Promise<TokenView[]> {
  const raw = await compute();
  const out: TokenView[] = [];
  for (const [tokenId, a] of raw.byToken) {
    const v = await toView(tokenId, a, raw, account, false);
    v.series = [];
    v.comments = [];
    out.push(v);
  }
  return out.sort((x, y) => (BigInt(y.marketCap) > BigInt(x.marketCap) ? 1 : -1));
}

/** Detail view: a single token with full series, trades, holders, comments. */
export async function detail(tokenId: string, account = ""): Promise<TokenView | null> {
  const raw = await compute();
  const a = raw.byToken.get(tokenId);
  if (!a) return null;
  return toView(tokenId, a, raw, account);
}