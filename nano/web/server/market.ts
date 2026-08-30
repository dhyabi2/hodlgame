// Market presentation layer: enrich the deterministic multi-token state with
// analytics (price/market-cap/holders/trades/series), off-chain metadata, and
// per-token pool addresses.

import { MultiIndexer, type IndexedEvent } from "../indexer/multiIndexer";
import { deriveAddress } from "nanocurrency";
import { NanoRpcSource } from "../indexer/blockSource";
import { analyze, type PricePoint, type TokenAnalytics, type DuelEvent } from "./analytics";
import { exitView, type ExitView } from "./exits";
import { tokenPoolKeys } from "./custody";
import { loadRegistry, EMPTY_META } from "./tokens";
import { commentsFor, type Comment } from "./comments";
import { commitResolver } from "./commits";
import { loadNanoRpcKey } from "../lib/rpc";
import { watchedAccounts, persistWatched } from "./operator";
import { StoreBlockCache } from "./sharedCache";
import { deriveMetaAuthority, type MetaAuthorityState } from "../core/metaAnchor";
import { claimableReward } from "../core/state";
import { futuresActive, markPrice, refPrice, type FutState } from "../core/futures";

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
  // ── "Exit Pays You" ───────────────────────────────────────────────────────
  // Every unstake, as a verifiable payout to the people who stayed. `exits` is
  // the recent tape (newest first; stripped on list views), `exitStats` the
  // totals incl. what THIS viewer has earned from others leaving.
  exits: ExitView[];
  exitStats: { count: number; paidRaw: string; burnedRaw: string; myEarnedRaw: string; lastTime: number };
  // ── Futures (core/futures.ts, SPEC §10) ───────────────────────────────────
  // Token-margined inverse positions. Prices are ×PRECISION (XNO raw per token
  // unit). `twap` is the display-time reference (Date.now()); consensus
  // recomputes it at each op's own timestamp.
  futures: FuturesView;
  spark: PricePoint[];
  series: PricePoint[];
  trades: TokenAnalytics["trades"];
  topHolders: TokenAnalytics["holders"];
  comments: Comment[];
}

export interface FuturesView {
  active: boolean;
  spot: string;
  twap: string;
  oiLong: string; // tokens: resting long size + all pair sizes
  oiShort: string;
  longWaiting: string; // resting (unmatched) long size — what a short taker can hit
  shortWaiting: string;
  openPairs: number; // count only — list views strip `pairs` but still show ⚔
  book: { id: string; account: string; side: 0 | 1; size: string; margin: string; guard: string }[];
  pairs: { id: string; size: string; entry: string; long: { account: string; margin: string }; short: { account: string; margin: string } }[];
  // Settled duels (newest first, last 20) — every row is a verifiable receipt
  // tied to the block that settled it.
  recent: DuelEvent[];
  duelCount: number;
  // THIS viewer's record across the token's full duel history. `opponents` is
  // the number of DISTINCT wallets beaten — self-dueling two wallets can never
  // grow it past 1, so it is the status number that resists sybils.
  myRecord: { wins: number; losses: number; liquidated: number; opponents: number; netPnl: string };
}

function futuresView(s: { poolXno: bigint; poolTokens: bigint; futures: FutState } | undefined, duels: DuelEvent[], account: string): FuturesView {
  const empty: FuturesView = {
    active: false, spot: "0", twap: "0", oiLong: "0", oiShort: "0", longWaiting: "0", shortWaiting: "0", openPairs: 0, book: [], pairs: [],
    recent: [], duelCount: 0, myRecord: { wins: 0, losses: 0, liquidated: 0, opponents: 0, netPnl: "0" },
  };
  if (!s) return empty;
  const rec = { wins: 0, losses: 0, liquidated: 0, opponents: 0, netPnl: "0" };
  if (account) {
    const beaten = new Set<string>();
    let net = 0n;
    for (const d of duels) {
      const mineLong = d.long === account, mineShort = d.short === account;
      if (!mineLong && !mineShort) continue;
      const pnl = mineLong ? BigInt(d.longPnl) : -BigInt(d.longPnl);
      net += pnl;
      if (pnl > 0n) { rec.wins++; beaten.add(mineLong ? d.short : d.long); }
      else if (pnl < 0n) { rec.losses++; if (d.kind === 1) rec.liquidated++; }
    }
    rec.opponents = beaten.size;
    rec.netPnl = net.toString();
  }
  const f = s.futures;
  const st = s as any;
  const spot = markPrice(st);
  // The reference is pure consensus state — no clock, so this view is exactly
  // what every replayer computes.
  const twap = refPrice(st, f);
  let lw = 0n, sw = 0n, paired = 0n;
  for (const o of f.book) if (o.side === 0) lw += o.size; else sw += o.size;
  for (const p of f.pairs) paired += p.size;
  return {
    active: futuresActive(f),
    spot: spot.toString(),
    twap: twap.toString(),
    oiLong: (lw + paired).toString(),
    oiShort: (sw + paired).toString(),
    longWaiting: lw.toString(),
    shortWaiting: sw.toString(),
    openPairs: f.pairs.length,
    // The consensus book is length-capped (MAX_BOOK_SIDE per side), so serving
    // it whole is bounded; list views strip it anyway. `guard` is the order's
    // limit price — what makes a real bid/ask ladder possible.
    book: f.book.map((o) => ({
      id: o.id.toString(),
      account: o.account,
      side: o.side,
      size: o.size.toString(),
      margin: o.margin.toString(),
      guard: o.guard.toString(),
    })),
    pairs: f.pairs.slice(-60).map((p) => ({
      id: p.id.toString(),
      size: p.size.toString(),
      entry: p.entry.toString(),
      long: { account: p.long.account, margin: p.long.margin.toString() },
      short: { account: p.short.account, margin: p.short.margin.toString() },
    })),
    recent: duels.slice(-20).reverse(),
    duelCount: duels.length,
    myRecord: rec,
  };
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
  /** The exact account set replayed to produce `state`/root — published by the
   * trust view so a browser can reproduce the SAME scope (and flag any account
   * it discovers that this set omits). */
  accounts: string[];
  /** account → the exact tip hash replayed for it, so a browser verifier can pin
   * its walk to the same frontier and match the root without a freshness race. */
  frontiers: Record<string, string>;
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
// In-flight coalescing (NOT a time cache — see the note above). A single warm
// instance often gets a burst of overlapping callers: the Explorer alone fires
// stats + feed + the SSE stream together, and token/state endpoints pile on. A
// bare compute() would run that identical full chain walk once PER caller. This
// shares ONE in-flight walk among everyone who asks while it's running, then
// clears — so the very next request after it settles computes fresh. There is
// no staleness window (unlike the deleted 2s cache): concurrent callers get the
// same "computed just now" result, which is strictly MORE consistent, and a
// caller arriving 1ms after settle still triggers a brand-new walk.
let inFlight: Promise<RawMarket> | null = null;

function compute(): Promise<RawMarket> {
  if (inFlight) return inFlight;
  const p = computeFresh().finally(() => { if (inFlight === p) inFlight = null; });
  inFlight = p;
  return p;
}

async function computeFresh(): Promise<RawMarket> {
  // Prologue reads are independent live sources — overlap them instead of
  // stacking three round-trips. Values are unchanged; only wall-clock differs.
  const [reg, commit, watched] = await Promise.all([loadRegistry(), commitResolver(), watchedAccounts()]);
  const master = process.env.POOL_SEED ?? "";
  const poolKey = (tokenId: string) => (master ? tokenPoolKeys(master, tokenId).publicKey : null);
  // Shared monotonic frontier + block cache (server-only): makes every request
  // fold the SAME freshest-ever verified chain per account, so holder counts /
  // poolXno / trades stop flickering across instances and RPC backends.
  const src = new NanoRpcSource(loadNanoRpcKey(), new StoreBlockCache());
  const idx = new MultiIndexer(src, (id) => reg.get(id) ?? EMPTY_META, commit, poolKey);
  let accounts = watched;
  let events = await idx.collectEvents(watched);
  // Second discovery pass: a creator's chain reveals each token's pool (the
  // seed-deposit link), even before the pool's own anchor hello lands — that
  // hello is only broadcast by the sweep cron, and only once the pool is
  // opened. Scanning those pools' counterparties (confirmed AND pending)
  // catches a first-time buyer whose only on-chain activity is deposit+buy,
  // so their holdings appear immediately instead of after the next sweep.
  const watchedSet = new Set(watched);
  const extra = new Set<string>();
  // Dedupe pool pubkeys first (a custody rotation can list the same pool in
  // several sets), then resolve counterparties in parallel — independent RPC
  // calls unioned into a Set, so the discovered `extra` set is identical to the
  // serial version, just faster. Over-inclusion is re-validated by replay.
  const poolPubs = [...new Set([...idx.getChainPoolSet().values()].flatMap((s) => [...s]))];
  const cps = await Promise.all(
    poolPubs.map((pub) => src.counterparties(deriveAddress(pub, { useNanoPrefix: true })).catch(() => null))
  );
  for (const cp of cps) {
    if (!cp) continue;
    for (const h of cp.inbound) if (!watchedSet.has(h.sender)) extra.add(h.sender);
  }
  if (extra.size > 0) {
    accounts = [...watchedSet, ...extra].sort();
    events = await idx.collectEvents(accounts);
    // Persist the first-time buyers found this pass into the shared watch-list
    // so they're replayed from the base set next time (fire-and-forget) — this
    // is what stops a holder count from flickering as discovery varies.
    void persistWatched([...watchedSet, ...extra]);
  }
  const { state, byToken, sellPayouts } = analyze(events);
  // Chain-derived metadata-authority state (core/metaAnchor.ts): seeded by
  // each launch creator, folded over on-chain immutable/setAuthority anchors.
  const creators = new Map<string, string>();
  for (const [tokenId, s] of state) if (s.creator) creators.set(tokenId, s.creator);
  const metaAuthority = deriveMetaAuthority(idx.getMetaAnchors(), creators);
  return { state, byToken, meta: reg, master, metaAuthority, events, idx, sellPayouts, accounts, frontiers: Object.fromEntries(src.frontiers) };
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
    exits: a.exits.events.slice(-30).reverse().map((e) => exitView(e, account)),
    exitStats: {
      count: a.exits.events.length,
      paidRaw: a.exits.paidRaw.toString(),
      burnedRaw: a.exits.burnedRaw.toString(),
      myEarnedRaw: account ? (a.exits.earned.get(account) ?? 0n).toString() : "0",
      lastTime: a.exits.events.length ? a.exits.events[a.exits.events.length - 1].time : 0,
    },
    futures: futuresView(s ?? undefined, a.duels, account),
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
    v.exits = v.exits.slice(0, 3); // home firehose: the latest exits per coin
    // Card views need only the ⚔ count and the depth totals — never the lists.
    v.futures = { ...v.futures, book: [], pairs: [], recent: [] };
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
    v.futures = { ...v.futures, book: [], pairs: [], recent: [] };
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