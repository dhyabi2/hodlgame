// Exchange Integration Kit (docs/EXCHANGE-KIT.md). Everything an exchange
// needs to list a HoldFun token, given that token balances live in the
// off-chain deterministic ledger (they verify the state root rather than
// trust it). Pure/read helpers here; the withdrawal signer is a library the
// exchange runs with ITS OWN key (client/exchangeWithdraw.ts) — we never hold
// the exchange's keys.

import { blake2bHex } from "blakejs";
import * as nanocurrency from "nanocurrency";
import { raw } from "./market";
import { stateRoot } from "../core/canonical";
import { balanceRoot, proveBalance, type MerkleProof } from "../core/merkle";
import type { State } from "../core/state";
import type { TokenAnalytics } from "./analytics";

const SITE = "https://www.hodlgame.fun";
const XNO_DECIMALS = 30;
const DAY = 86400;

/** Format a raw integer string as a human decimal for `decimals` places. */
function fmtDec(raw: string, decimals: number): string {
  const neg = raw.startsWith("-");
  let s = neg ? raw.slice(1) : raw;
  if (decimals <= 0) return raw;
  s = s.padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  const frac = s.slice(cut).replace(/0+$/, "");
  return (neg ? "-" : "") + s.slice(0, cut) + (frac ? "." + frac : "");
}

/** Released supply = total minus the creator's un-distributed treasury reserve.
 * (Creator's held 5% and staked tokens ARE circulating — they're owned/out.) */
function circulatingRaw(s: State): bigint {
  const c = s.supply - s.treasury;
  return c > 0n ? c : 0n;
}

/** 24h base (token) and quote (XNO) volume from the trade feed. */
function vol24(a: TokenAnalytics, decimals: number, now: number): { base: bigint; quote: bigint } {
  const cutoff = now - DAY;
  const scale = 10n ** BigInt(decimals);
  let base = 0n;
  let quote = 0n;
  for (const t of a.trades) {
    if (t.time < cutoff) continue;
    const amt = BigInt(t.amountRaw);
    base += amt;
    quote += (amt * BigInt(t.priceRaw)) / scale;
  }
  return { base, quote };
}

/** % price change over the last 24h from the price series (step function). */
function priceChange24h(a: TokenAnalytics, now: number): number | null {
  if (a.series.length < 2) return null;
  const last = BigInt(a.series[a.series.length - 1].priceRaw);
  const target = now - DAY;
  let base = a.series[0];
  for (const p of a.series) if (p.time >= target) { base = p; break; }
  const prev = BigInt(base.priceRaw);
  if (prev === 0n) return null;
  const bps = ((last - prev) * 10_000n) / prev;
  const pct = Number(bps) / 100;
  return Number.isFinite(pct) ? pct : null;
}

const absImg = (image: string) => (/^\/api\/image\/[0-9a-f]{32}$/.test(image) ? SITE + image : image || null);

/** CoinMarketCap / CoinGecko-style tickers for EVERY coin — the endpoint an
 * aggregator or DEX tracker polls to list HodlGame markets. base is the coin,
 * target is XNO. Values are human decimals; *_raw give the exact integers. */
export async function tickers() {
  const m = await raw();
  const now = Math.floor(Date.now() / 1000);
  const list = [...m.state.entries()].map(([tokenId, s]) => {
    const a = m.byToken.get(tokenId);
    const dec = s.decimals;
    const v = a ? vol24(a, dec, now) : { base: 0n, quote: 0n };
    return {
      ticker_id: `${tokenId}_XNO`,
      base_currency: s.symbol || tokenId.slice(0, 6).toUpperCase(),
      target_currency: "XNO",
      tokenId,
      symbol: s.symbol,
      name: s.name,
      decimals: dec,
      last_price: fmtDec(a?.priceRaw ?? "0", XNO_DECIMALS),
      last_price_raw: a?.priceRaw ?? "0",
      base_volume: fmtDec(v.base.toString(), dec),
      target_volume: fmtDec(v.quote.toString(), XNO_DECIMALS),
      liquidity_in_xno: fmtDec(s.poolXno.toString(), XNO_DECIMALS),
      pool_xno_raw: s.poolXno.toString(),
      pool_tokens_raw: s.poolTokens.toString(),
      circulating_supply: fmtDec(circulatingRaw(s).toString(), dec),
      total_supply: fmtDec(s.supply.toString(), dec),
      market_cap_xno: fmtDec(a?.marketCapRaw ?? "0", XNO_DECIMALS),
      price_change_24h_pct: a ? priceChange24h(a, now) : null,
      holders: a?.holders.length ?? 0,
      created_at: a?.launchTime ?? null,
      explorer: `${SITE}/t/${tokenId}`,
    };
  });
  return { updated: now, quote_currency: "XNO", tickers: list };
}

/** OHLCV candles bucketed from the trade feed (interval in seconds). */
export async function ohlcv(tokenId: string, interval = 3600, limit = 300) {
  const m = await raw();
  const s = m.state.get(tokenId);
  const a = m.byToken.get(tokenId);
  if (!s || !a) return null;
  const scale = 10n ** BigInt(s.decimals);
  const iv = Math.max(60, Math.min(interval, DAY));
  const buckets = new Map<number, { t: number; o: bigint; h: bigint; l: bigint; c: bigint; vol: bigint }>();
  for (const t of [...a.trades].sort((x, y) => x.time - y.time)) {
    const bk = Math.floor(t.time / iv) * iv;
    const p = BigInt(t.priceRaw);
    const q = (BigInt(t.amountRaw) * p) / scale;
    const cur = buckets.get(bk);
    if (!cur) buckets.set(bk, { t: bk, o: p, h: p, l: p, c: p, vol: q });
    else { if (p > cur.h) cur.h = p; if (p < cur.l) cur.l = p; cur.c = p; cur.vol += q; }
  }
  const candles = [...buckets.values()].sort((x, y) => x.t - y.t).slice(-limit).map((c) => ({
    time: c.t,
    open: fmtDec(c.o.toString(), XNO_DECIMALS),
    high: fmtDec(c.h.toString(), XNO_DECIMALS),
    low: fmtDec(c.l.toString(), XNO_DECIMALS),
    close: fmtDec(c.c.toString(), XNO_DECIMALS),
    volume_xno: fmtDec(c.vol.toString(), XNO_DECIMALS),
  }));
  return { tokenId, interval: iv, candles };
}

/** Recent trades (CMC `historical_trades` shape) — newest first. */
export async function recentTrades(tokenId: string, limit = 200) {
  const m = await raw();
  const s = m.state.get(tokenId);
  const a = m.byToken.get(tokenId);
  if (!s || !a) return null;
  const scale = 10n ** BigInt(s.decimals);
  const trades = [...a.trades].sort((x, y) => y.time - x.time).slice(0, Math.min(Math.max(limit, 1), 1000)).map((t) => ({
    trade_id: `${t.time}-${t.kind}-${t.amountRaw}`,
    type: t.kind,
    price: fmtDec(t.priceRaw, XNO_DECIMALS),
    base_volume: fmtDec(t.amountRaw, s.decimals),
    target_volume: fmtDec(((BigInt(t.amountRaw) * BigInt(t.priceRaw)) / scale).toString(), XNO_DECIMALS),
    timestamp: t.time,
  }));
  return { tokenId, trades };
}

/** Full listing-metadata package (logo, socials, supply, circulating) — what an
 * exchange/aggregator autofills its asset page from. */
export async function assetMeta(tokenId: string) {
  const m = await raw();
  const s = m.state.get(tokenId);
  if (!s) return null;
  const reg: any = m.meta.get(tokenId) ?? {};
  const a = m.byToken.get(tokenId);
  const authority = m.metaAuthority.get(tokenId);
  return {
    tokenId,
    symbol: s.symbol,
    name: s.name,
    decimals: s.decimals,
    total_supply: fmtDec(s.supply.toString(), s.decimals),
    circulating_supply: fmtDec(circulatingRaw(s).toString(), s.decimals),
    max_supply: fmtDec(s.supply.toString(), s.decimals),
    creator: s.creator,
    metadataAuthority: authority?.authority ?? s.creator ?? null,
    metadataImmutable: Boolean(authority?.immutable),
    logo: absImg(reg.image ?? ""),
    description: reg.description ?? "",
    website: reg.website ?? "",
    twitter: reg.twitter ?? "",
    telegram: reg.telegram ?? "",
    price_xno: fmtDec(a?.priceRaw ?? "0", XNO_DECIMALS),
    market_cap_xno: fmtDec(a?.marketCapRaw ?? "0", XNO_DECIMALS),
    holders: a?.holders.length ?? 0,
    launch_time: a?.launchTime ?? null,
    explorer: `${SITE}/t/${tokenId}`,
  };
}

/**
 * Deterministic per-customer deposit account, HD-derived from the exchange's
 * own master seed: seed = blake2b(master ‖ "holdfun-deposit" ‖ customerId).
 * The exchange watches these accounts; a token transfer to one credits that
 * customer. Derivation is the exchange's alone — HoldFun never sees the seed.
 */
export function depositSeed(masterSeed: string, customerId: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(masterSeed)) throw new Error("master seed must be 64 hex");
  const payload = Buffer.concat([
    Buffer.from(masterSeed, "hex"),
    Buffer.from("holdfun-deposit\0", "utf8"),
    Buffer.from(customerId, "utf8"),
  ]);
  return blake2bHex(payload, undefined, 32);
}

export function depositAddress(masterSeed: string, customerId: string): string {
  const sk = nanocurrency.deriveSecretKey(depositSeed(masterSeed, customerId), 0);
  return nanocurrency.deriveAddress(nanocurrency.derivePublicKey(sk), { useNanoPrefix: true });
}

export interface TokenInfo {
  tokenId: string;
  symbol: string;
  name: string;
  decimals: number; // consensus-bound in the launch op link — safe to pin
  supply: string;
  circulatingRaw: string; // released supply (total − treasury reserve)
  creator: string;
  metadataAuthority: string | null;
  metadataImmutable: boolean;
  priceRaw: string;
  poolAddress: string | null;
  poolXnoRaw: string; // AMM reserves — the token's liquidity depth
  poolTokensRaw: string;
  volume24hXnoRaw: string; // 24h quote volume in XNO raw
  priceChange24hPct: number | null;
  holders: number;
}

/** Everything an exchange pins to list a token. `decimals` comes from the
 * launch op link (consensus), NOT the mutable registry — see oplink.ts. */
export async function tokenInfo(tokenId: string): Promise<TokenInfo | null> {
  const m = await raw();
  const s = m.state.get(tokenId);
  if (!s) return null;
  const authority = m.metaAuthority.get(tokenId);
  const pub = m.idx.getChainPools().get(tokenId);
  const analytics = m.byToken.get(tokenId);
  const now = Math.floor(Date.now() / 1000);
  return {
    tokenId,
    symbol: s.symbol,
    name: s.name,
    decimals: s.decimals, // from the launch link (consensus); verify via the
    // launch block's link byte 1 (decimals+1) — see docs/EXCHANGE-KIT.md.
    supply: s.supply.toString(),
    circulatingRaw: circulatingRaw(s).toString(),
    creator: s.creator,
    metadataAuthority: authority?.authority ?? s.creator ?? null,
    metadataImmutable: Boolean(authority?.immutable),
    priceRaw: analytics?.priceRaw ?? "0",
    poolAddress: pub ? nanocurrency.deriveAddress(pub, { useNanoPrefix: true }) : null,
    poolXnoRaw: s.poolXno.toString(),
    poolTokensRaw: s.poolTokens.toString(),
    volume24hXnoRaw: (analytics ? vol24(analytics, s.decimals, now).quote : 0n).toString(),
    priceChange24hPct: analytics ? priceChange24h(analytics, now) : null,
    holders: analytics?.holders.length ?? 0,
  };
}

export interface BalanceInfo {
  tokenId: string;
  account: string;
  balanceRaw: string;
  decimals: number;
  stateRoot: string; // pin this + verify.ts to prove the balance from chain
}

/** A customer's token balance plus the state root that authenticates it.
 * The exchange verifies the root with scripts/verify.ts (zero secrets) and
 * trusts the balance because it is the replay, not a claim. */
export async function tokenBalance(tokenId: string, account: string): Promise<BalanceInfo> {
  const m = await raw();
  const s = m.state.get(tokenId);
  return {
    tokenId,
    account,
    balanceRaw: (s?.balances.get(account) ?? 0n).toString(),
    decimals: s?.decimals ?? 6,
    stateRoot: stateRoot(m.state),
  };
}

export interface BalanceProofInfo {
  tokenId: string;
  account: string;
  balanceRaw: string;
  balanceRoot: string; // Merkle root over all holdings — establish once, reuse
  proof: MerkleProof | null; // null if the account holds none of this token
  stateRoot: string;
}

/** A Merkle inclusion proof of one holding against the balance root. Lets a
 * light exchange verify this balance in O(log N) with core/merkle
 * verifyMerkleProof — no full replay — after it has established the balance
 * root once by RECOMPUTING it from its own periodic replay. The balance root
 * has NO on-chain anchor and is not committed by the state root, so an exchange
 * must never accept a server-supplied root at face value (see core/merkle.ts
 * trust model). */
export async function balanceProof(tokenId: string, account: string): Promise<BalanceProofInfo> {
  const m = await raw();
  const s = m.state.get(tokenId);
  return {
    tokenId,
    account,
    balanceRaw: (s?.balances.get(account) ?? 0n).toString(),
    balanceRoot: balanceRoot(m.state),
    proof: proveBalance(m.state, tokenId, account),
    stateRoot: stateRoot(m.state),
  };
}
