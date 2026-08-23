// Explorer API assembly: joins the raw market internals (events, indexer,
// analytics, payouts) with the pure explorer engine (deltas, classification,
// payout attribution, link annotation) into the JSON each explorer view needs.
// Everything re-derives from chain-derived data on request — no explorer-owned
// storage, no mock data.

import * as nanocurrency from "nanocurrency";
import { raw } from "./market";
import { replayWithDeltas, classifyLink, attributePoolSends, annotateLink, type OpDelta } from "./explorer";
import { computeRefunds, creditedBuys } from "./reconcile";
import { readPoolDepositsFromChain } from "./sweep";
import { poolOutgoingByRecipient, entitlementsFor, netObligations } from "./settled";
import { stateRoot } from "../core/canonical";
import { ANCHOR_ADDRESS } from "../core/anchor";
import { exportSnapshot, isAnchored } from "./snapshot";
import { NanoRpcSource } from "../indexer/blockSource";
import { loadNanoRpcKey, nanoRpc } from "../lib/rpc";
import { isTokenId, isNanoAddress } from "./validate";

const pubToAddress = (pub: string) => nanocurrency.deriveAddress(pub.toLowerCase(), { useNanoPrefix: true });

type Raw = Awaited<ReturnType<typeof raw>>;

function meta(tokenId: string, regRow: any) {
  return {
    name: regRow?.name || `Coin ${tokenId.slice(0, 6)}`,
    symbol: regRow?.symbol || tokenId.slice(0, 4).toUpperCase(),
    image: regRow?.image ?? "",
    description: regRow?.description ?? "",
    website: regRow?.website ?? "",
    twitter: regRow?.twitter ?? "",
    telegram: regRow?.telegram ?? "",
  };
}

function enrich(deltas: OpDelta[], m: Raw) {
  const edges = m.idx.getDepositEdges();
  return deltas.map((d) => {
    const r = m.meta.get(d.tokenId);
    return { ...d, name: r?.name || `Coin ${d.tokenId.slice(0, 6)}`, symbol: r?.symbol || d.tokenId.slice(0, 4).toUpperCase(), depositEdge: edges.get(d.hash) ?? null };
  });
}

/** % price change over `secondsAgo`, from the analytics series. */
function changePct(series: { time: number; priceRaw: string }[] | undefined, secondsAgo: number): number | null {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const target = last.time - secondsAgo;
  let base = series[0];
  for (const p of series) if (p.time >= target) { base = p; break; }
  const cur = BigInt(last.priceRaw), prev = BigInt(base.priceRaw);
  if (prev === 0n) return null;
  const pct = Number((cur - prev) * 10_000n / prev) / 100;
  return Number.isFinite(pct) ? pct : null;
}

// ── Overview / stats dashboard ──────────────────────────────────────────────

export async function stats() {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  let tvl = 0n, vol24 = 0n, holders = 0, invalid = 0;
  const now = Math.floor(Date.now() / 1000);
  const tokens: any[] = [];
  for (const [tokenId, s] of m.state) {
    const a = m.byToken.get(tokenId);
    tvl += s.poolXno;
    holders += s.balances.size;
    if (a) {
      for (const t of a.trades) if (now - t.time <= 86400) vol24 += BigInt(t.amountRaw);
      tokens.push({
        tokenId, ...meta(tokenId, m.meta.get(tokenId)),
        priceRaw: a.priceRaw, marketCapRaw: a.marketCapRaw, holders: s.balances.size,
        change24h: changePct(a.series, 86400), createdAt: a.launchTime,
      });
    }
  }
  for (const d of deltas) if (!d.valid) invalid++;
  const topByMcap = [...tokens].sort((x, y) => (BigInt(y.marketCapRaw) > BigInt(x.marketCapRaw) ? 1 : -1)).slice(0, 10);
  const latest = [...tokens].sort((x, y) => y.createdAt - x.createdAt).slice(0, 10);
  return {
    totalTokens: m.state.size,
    totalOps: deltas.length,
    invalidOps: invalid,
    totalHolders: holders,
    tvlRaw: tvl.toString(),
    volume24hRaw: vol24.toString(),
    stateRoot: stateRoot(m.state),
    topByMcap,
    latest,
  };
}

// ── Op feed (paginated + filterable) ────────────────────────────────────────

export async function feed(opts: { cursor?: number; limit?: number; kind?: string; token?: string } = {}) {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  // Order strictly newest-first by the block's wall-clock time. Replay order is
  // lamport/fixpoint — CAUSAL, not chronological — so a bare .reverse() left
  // ops interleaved (e.g. launches, each on a different creator account, were
  // ordered by discovery, not by launch time). Sort by real block time instead.
  // A block missing local_timestamp (unconfirmed) inherits the previous op's
  // time (carry-forward in replay order) so it stays beside its causal
  // neighbour instead of sinking to epoch 0; ties break by reverse replay index
  // so the sort is total and deterministic.
  // Drop synthetic `balance` observations: they're ledger-internal (head
  // balance snapshots that prorate collateral, part of the state root) but not
  // a user action, carry no block timestamp, and aren't in the kind chips — in
  // the human activity feed they're pure noise that also can't be time-ordered.
  // Every real op (buy/sell/launch/seedLiq/stake/…) has a real block time.
  const real = deltas.filter((d) => d.kind !== "balance");
  let carry = 0;
  const timed = real.map((d, i) => {
    const t = d.timestamp && d.timestamp > 0 ? d.timestamp : carry;
    carry = t;
    return { d, i, t };
  });
  timed.sort((a, b) => b.t - a.t || b.i - a.i);
  let items = enrich(timed.map((x) => x.d), m);
  if (opts.kind) items = items.filter((d) => d.kind === opts.kind);
  if (opts.token) items = items.filter((d) => d.tokenId === opts.token!.toLowerCase());
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursor = Math.max(opts.cursor ?? 0, 0);
  const page = items.slice(cursor, cursor + limit);
  return { items: page, total: items.length, cursor, nextCursor: cursor + limit < items.length ? cursor + limit : null };
}

// ── Op detail (deltas + edges + payout story + raw + confirmations) ─────────

export async function opDetail(hash: string) {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  const h = hash.toLowerCase();
  const item = deltas.find((d) => d.hash.toLowerCase() === h || d.carriers?.some((c) => c.toLowerCase() === h));
  if (!item) return null;
  const [enriched] = enrich([item], m);
  const key = loadNanoRpcKey();

  // Raw block(s) + confirmation + absolute time from the chain.
  const hashes = item.carriers ?? [item.hash];
  const blocks: any[] = [];
  let confirmed = false, timestamp: number | undefined;
  for (const bh of hashes) {
    const info = await nanoRpc(key, { action: "block_info", hash: bh, json_block: true }).catch(() => null);
    if (info?.contents) {
      confirmed = confirmed || info.confirmed === "true" || info.confirmed === true;
      if (info.local_timestamp) timestamp = Number(info.local_timestamp);
      blocks.push({ hash: bh, account: info.block_account, link: info.contents.link, representative: info.contents.representative, balance: info.contents.balance, previous: info.contents.previous, signature: info.contents.signature, annotation: annotateLink(info.contents.link ?? "") });
    }
  }

  // Sell ops: attribute the pool payout send(s) that covered this sell.
  let coverage = null;
  const poolPub = m.idx.getChainPools().get(item.tokenId);
  if (item.kind === "sell" && item.valid && poolPub) {
    try {
      const src = new NanoRpcSource(key);
      const poolAddress = pubToAddress(poolPub);
      const poolBlocks = await src.listBlocks(poolAddress);
      const poolReceived = await readPoolDepositsFromChain(key, { address: poolAddress, publicKey: poolPub, secretKey: "" } as any, poolBlocks);
      const credits = creditedBuys(m.events).get(item.tokenId) ?? new Map();
      const refunds = computeRefunds(poolReceived, credits);
      const sells = m.sellPayouts.filter((p) => p.tokenId === item.tokenId);
      const all = attributePoolSends(poolBlocks, sells, refunds, pubToAddress);
      coverage = all.filter((c) => c.covers.some((x) => x.hash?.toLowerCase() === item.hash.toLowerCase()));
    } catch {
      coverage = null;
    }
  }
  return { ...enriched, timestamp: timestamp ?? enriched.timestamp, confirmed, poolPub: poolPub ?? null, payoutCoverage: coverage, blocks };
}

// ── Account (holdings + labels + ops + XNO flows, paginated) ─────────────────

export async function accountView(address: string, cursor = 0, limit = 50) {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  const holdings: any[] = [];
  const authorityOf: any[] = [];
  const createdTokens: any[] = [];
  for (const [tokenId, s] of m.state) {
    const bal = s.balances.get(address) ?? 0n;
    const stk = s.staked.get(address) ?? 0n;
    const bank = s.banked.get(address) ?? 0n;
    if (bal > 0n || stk > 0n || bank > 0n) {
      const a = m.byToken.get(tokenId);
      holdings.push({ tokenId, ...meta(tokenId, m.meta.get(tokenId)), balance: bal.toString(), staked: stk.toString(), banked: bank.toString(), decimals: s.decimals, priceRaw: a?.priceRaw ?? "0" });
    }
    if (s.creator === address) createdTokens.push({ tokenId, ...meta(tokenId, m.meta.get(tokenId)) });
    if (m.metaAuthority.get(tokenId)?.authority === address) authorityOf.push({ tokenId, ...meta(tokenId, m.meta.get(tokenId)) });
  }
  const allOps = enrich(deltas.filter((d) => d.sender === address), m).reverse();
  const page = allOps.slice(cursor, cursor + limit);
  const labels: string[] = [];
  if (address === ANCHOR_ADDRESS) labels.push("protocol anchor");
  for (const [tokenId, pub] of m.idx.getChainPools()) {
    if (pubToAddress(pub) === address) labels.push(`pool of ${m.meta.get(tokenId)?.symbol || tokenId.slice(0, 8)}`);
  }
  const info = await nanoRpc(loadNanoRpcKey(), { action: "account_info", account: address }).catch(() => null);
  return {
    address,
    xnoBalanceRaw: info?.balance ?? "0",
    opened: Boolean(info?.frontier),
    labels,
    holdings,
    createdTokens,
    authorityOf,
    ops: page,
    opsTotal: allOps.length,
    cursor,
    nextCursor: cursor + limit < allOps.length ? cursor + limit : null,
  };
}

// ── Token page (full: analytics, socials, trades, series, holders, reserves) ─

export async function tokenExplorer(tokenId: string, holderCursor = 0) {
  const m = await raw();
  const s = m.state.get(tokenId);
  if (!s) return null;
  const { deltas } = replayWithDeltas(m.events);
  const a = m.byToken.get(tokenId);
  const supply = s.supply;
  const allHolders = [...s.balances.entries()].sort((x, y) => (y[1] > x[1] ? 1 : -1));
  const holders = allHolders.slice(holderCursor, holderCursor + 50).map(([account, bal]) => ({
    account, balance: bal.toString(), pct: supply > 0n ? Number((bal * 10_000n) / supply) / 100 : 0,
  }));
  // Concentration: top-10 share of circulating (balances).
  const circ = [...s.balances.values()].reduce((x, y) => x + y, 0n);
  const top10 = allHolders.slice(0, 10).reduce((x, [, y]) => x + y, 0n);
  const top10Pct = circ > 0n ? Number((top10 * 10_000n) / circ) / 100 : 0;

  const poolPub = m.idx.getChainPools().get(tokenId) ?? null;
  let reserves = null;
  if (poolPub) {
    const key = loadNanoRpcKey();
    const addr = pubToAddress(poolPub);
    const info = await nanoRpc(key, { action: "account_info", account: addr }).catch(() => null);
    const pendRaw = await nanoRpc(key, { action: "pending", account: addr, count: 100, threshold: "1" }).catch(() => null);
    reserves = {
      poolAddress: addr,
      indexedPoolXno: s.poolXno.toString(),
      onchainBalance: info?.balance ?? "0",
      pendingCount: Array.isArray(pendRaw?.blocks) ? pendRaw.blocks.length : Object.keys(pendRaw?.blocks ?? {}).length,
      backed: info ? BigInt(info.balance) >= s.poolXno : null,
    };
  }
  const launch = deltas.find((d) => d.tokenId === tokenId && d.kind === "launch");
  const initialSupply = BigInt(launch?.fields?.supply?.after ?? supply.toString());
  return {
    tokenId,
    ...meta(tokenId, m.meta.get(tokenId)),
    decimals: s.decimals,
    creator: s.creator,
    launched: s.launched,
    launchHash: launch?.hash ?? null,
    createdAt: a?.launchTime ?? launch?.timestamp ?? null,
    supply: supply.toString(),
    treasury: s.treasury.toString(),
    poolTokens: s.poolTokens.toString(),
    totalStaked: s.totalStaked.toString(),
    rebateVault: s.rebateVault.toString(),
    burned: (initialSupply - supply).toString(),
    priceRaw: a?.priceRaw ?? "0",
    marketCapRaw: a?.marketCapRaw ?? "0",
    change1h: changePct(a?.series, 3600),
    change24h: changePct(a?.series, 86400),
    buyVolumeRaw: a?.buyVolumeRaw ?? "0",
    sellVolumeRaw: a?.sellVolumeRaw ?? "0",
    series: a?.series ?? [],
    trades: (a?.trades ?? []).slice(-50).reverse(),
    authority: m.metaAuthority.get(tokenId) ?? null,
    holders,
    holdersTotal: allHolders.length,
    holderCursor,
    holderNextCursor: holderCursor + 50 < allHolders.length ? holderCursor + 50 : null,
    concentration: { top10Pct, holderCount: allHolders.length },
    direct: s.direct, // zero-custody v2 coin — no pool account, so no reserves to prove
    reserves,
    ops: enrich(deltas.filter((d) => d.tokenId === tokenId), m).reverse().slice(0, 100),
  };
}

// ── Trust dashboard (proof of reserves) ─────────────────────────────────────

export async function trustDashboard() {
  const m = await raw();
  const key = loadNanoRpcKey();
  const src = new NanoRpcSource(key);
  const root = stateRoot(m.state);
  const pools: any[] = [];
  const credits = creditedBuys(m.events);
  for (const [tokenId, pub] of m.idx.getChainPools()) {
    const s = m.state.get(tokenId);
    if (!s) continue;
    const address = pubToAddress(pub);
    const info = await nanoRpc(key, { action: "account_info", account: address }).catch(() => null);
    let outstanding = "0";
    try {
      const poolBlocks = await src.listBlocks(address);
      const poolReceived = await readPoolDepositsFromChain(key, { address, publicKey: pub, secretKey: "" } as any, poolBlocks);
      const refunds = computeRefunds(poolReceived, credits.get(tokenId) ?? new Map());
      const entitled = entitlementsFor(m.state.get(tokenId)?.xnoWithdrawn ?? new Map(), refunds);
      const obligations = netObligations(entitled, poolOutgoingByRecipient(poolBlocks));
      outstanding = obligations.reduce((x, o) => x + o.amountRaw, 0n).toString();
    } catch {
      outstanding = "rpc-error";
    }
    pools.push({ tokenId, symbol: m.meta.get(tokenId)?.symbol || tokenId.slice(0, 4).toUpperCase(), poolAddress: address, indexedPoolXno: s.poolXno.toString(), onchainBalance: info?.balance ?? "0", outstandingObligations: outstanding });
  }
  const snap = await exportSnapshot();
  let snapshotAnchored = false;
  try { snapshotAnchored = isAnchored(await src.listBlocks(ANCHOR_ADDRESS), snap.hash); } catch {}
  return { stateRoot: root, tokens: m.state.size, events: m.events.length, accounts: m.accounts, pools, snapshot: { hash: snap.hash, bytes: snap.json.length, anchored: snapshotAnchored }, anchor: ANCHOR_ADDRESS };
}

// ── Unified search ──────────────────────────────────────────────────────────

export async function search(q: string) {
  const query = q.trim();
  if (isTokenId(query)) {
    const t = await tokenExplorer(query.toLowerCase());
    if (t) return { type: "token", data: t };
  }
  if (isNanoAddress(query)) return { type: "account", data: await accountView(query) };
  if (/^[0-9a-fA-F]{64}$/.test(query)) {
    const op = await opDetail(query);
    if (op) return { type: "op", data: op };
    const info = await nanoRpc(loadNanoRpcKey(), { action: "block_info", hash: query, json_block: true }).catch(() => null);
    if (info?.contents) {
      const m = await raw();
      const poolByPub = new Map([...m.idx.getChainPools()].map(([t, p]) => [p, t]));
      const cls = classifyLink(info.contents.link ?? "", { amount: info.amount, representative: info.contents.representative, poolByPub });
      return { type: "block", data: { hash: query, account: info.block_account, amount: info.amount, subtype: (info as any).subtype, confirmed: info.confirmed === "true" || info.confirmed === true, classification: cls, annotation: annotateLink(info.contents.link ?? "") } };
    }
    return { type: "not-found", data: null };
  }
  const m = await raw();
  const ql = (query as string).toLowerCase();
  const matches: any[] = [];
  for (const [tokenId, s] of m.state) {
    const row = m.meta.get(tokenId);
    if ((row?.name ?? "").toLowerCase().includes(ql) || (row?.symbol ?? "").toLowerCase().includes(ql)) {
      const a = m.byToken.get(tokenId);
      matches.push({ tokenId, ...meta(tokenId, row), supply: s.supply.toString(), priceRaw: a?.priceRaw ?? "0", marketCapRaw: a?.marketCapRaw ?? "0", holders: s.balances.size });
    }
  }
  return { type: "tokens", data: matches };
}
