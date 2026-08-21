// Explorer API assembly: joins the raw market internals (events, indexer,
// payouts) with the pure explorer engine (deltas, classification, payout
// attribution) into the JSON each explorer view needs. Everything re-derives
// from chain-derived data on request — no explorer-owned storage.

import * as nanocurrency from "nanocurrency";
import { raw } from "./market";
import { replayWithDeltas, classifyLink, attributePoolSends, type OpDelta } from "./explorer";
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

function meta(regRow: any) {
  return { name: regRow?.name ?? "", symbol: regRow?.symbol ?? "", image: regRow?.image ?? "" };
}

function enrich(deltas: OpDelta[], m: Awaited<ReturnType<typeof raw>>) {
  const edges = m.idx.getDepositEdges();
  return deltas.map((d) => ({
    ...d,
    ...meta(m.meta.get(d.tokenId)),
    depositEdge: edges.get(d.hash) ?? null,
  }));
}

export async function feed(limit = 100) {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  return { items: enrich(deltas, m).reverse().slice(0, limit), total: deltas.length };
}

export async function opDetail(hash: string) {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  const h = hash.toLowerCase();
  const item = deltas.find((d) => d.hash.toLowerCase() === h || d.carriers?.some((c) => c.toLowerCase() === h));
  if (!item) return null;
  const [enriched] = enrich([item], m);

  // Sell ops: attribute the pool payout send(s) that covered this sell.
  let coverage = null;
  const poolPub = m.idx.getChainPools().get(item.tokenId);
  if (item.kind === "sell" && item.valid && poolPub) {
    try {
      const src = new NanoRpcSource(loadNanoRpcKey());
      const poolAddress = pubToAddress(poolPub);
      const poolBlocks = await src.listBlocks(poolAddress);
      const poolReceived = await readPoolDepositsFromChain(
        loadNanoRpcKey(),
        { address: poolAddress, publicKey: poolPub, secretKey: "" } as any,
        poolBlocks
      );
      const credits = creditedBuys(m.events).get(item.tokenId) ?? new Map();
      const refunds = computeRefunds(poolReceived, credits);
      const sells = m.sellPayouts.filter((p) => p.tokenId === item.tokenId);
      const all = attributePoolSends(poolBlocks, sells, refunds, pubToAddress);
      coverage = all.filter((c) => c.covers.some((x) => x.hash?.toLowerCase() === item.hash.toLowerCase()));
    } catch {
      coverage = null; // RPC hiccup → story panel degrades, page still renders
    }
  }
  return { ...enriched, poolPub: poolPub ?? null, payoutCoverage: coverage };
}

export async function accountView(address: string) {
  const m = await raw();
  const { deltas } = replayWithDeltas(m.events);
  const holdings: any[] = [];
  const authorityOf: string[] = [];
  const createdTokens: string[] = [];
  for (const [tokenId, s] of m.state) {
    const bal = s.balances.get(address) ?? 0n;
    const stk = s.staked.get(address) ?? 0n;
    const bank = s.banked.get(address) ?? 0n;
    if (bal > 0n || stk > 0n || bank > 0n) {
      holdings.push({ tokenId, ...meta(m.meta.get(tokenId)), balance: bal.toString(), staked: stk.toString(), banked: bank.toString(), decimals: m.meta.get(tokenId)?.decimals ?? 6 });
    }
    if (s.creator === address) createdTokens.push(tokenId);
    if (m.metaAuthority.get(tokenId)?.authority === address) authorityOf.push(tokenId);
  }
  const ops = enrich(deltas.filter((d) => d.sender === address), m).reverse().slice(0, 100);
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
    ops,
  };
}

export async function tokenExplorer(tokenId: string) {
  const m = await raw();
  const s = m.state.get(tokenId);
  if (!s) return null;
  const { deltas } = replayWithDeltas(m.events);
  const holders = [...s.balances.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .map(([account, bal]) => ({ account, balance: bal.toString() }));
  const poolPub = m.idx.getChainPools().get(tokenId) ?? null;
  let reserves = null;
  if (poolPub) {
    const info = await nanoRpc(loadNanoRpcKey(), { action: "account_info", account: pubToAddress(poolPub) }).catch(() => null);
    const pendRaw = await nanoRpc(loadNanoRpcKey(), { action: "pending", account: pubToAddress(poolPub), count: 100, threshold: "1" }).catch(() => null);
    reserves = {
      poolAddress: pubToAddress(poolPub),
      indexedPoolXno: s.poolXno.toString(),
      onchainBalance: info?.balance ?? "0",
      pendingCount: Array.isArray(pendRaw?.blocks) ? pendRaw.blocks.length : Object.keys(pendRaw?.blocks ?? {}).length,
    };
  }
  const launch = deltas.find((d) => d.tokenId === tokenId && d.kind === "launch");
  const initialSupply = BigInt(launch?.fields?.supply?.after ?? s.supply.toString());
  return {
    tokenId,
    ...meta(m.meta.get(tokenId)),
    decimals: m.meta.get(tokenId)?.decimals ?? 6,
    creator: s.creator,
    launched: s.launched,
    launchHash: launch?.hash ?? null,
    supply: s.supply.toString(),
    treasury: s.treasury.toString(),
    poolTokens: s.poolTokens.toString(),
    totalStaked: s.totalStaked.toString(),
    rebateVault: s.rebateVault.toString(),
    burned: (initialSupply - s.supply).toString(),
    authority: m.metaAuthority.get(tokenId) ?? null,
    holders,
    reserves,
    ops: enrich(deltas.filter((d) => d.tokenId === tokenId), m).reverse().slice(0, 200),
  };
}

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
      const entitled = entitlementsFor(tokenId, m.sellPayouts, refunds);
      const obligations = netObligations(entitled, poolOutgoingByRecipient(poolBlocks));
      outstanding = obligations.reduce((a, o) => a + o.amountRaw, 0n).toString();
    } catch {
      outstanding = "rpc-error";
    }
    pools.push({
      tokenId,
      symbol: m.meta.get(tokenId)?.symbol ?? "",
      poolAddress: address,
      indexedPoolXno: s.poolXno.toString(),
      onchainBalance: info?.balance ?? "0",
      outstandingObligations: outstanding,
    });
  }

  const snap = await exportSnapshot();
  let snapshotAnchored = false;
  try {
    snapshotAnchored = isAnchored(await src.listBlocks(ANCHOR_ADDRESS), snap.hash);
  } catch {}

  return {
    stateRoot: root,
    tokens: m.state.size,
    events: m.events.length,
    pools,
    snapshot: { hash: snap.hash, bytes: snap.json.length, anchored: snapshotAnchored },
    anchor: ANCHOR_ADDRESS,
  };
}

/** E1 unified search: route a query to the right view. */
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
    // Not one of ours — classify the raw block for context.
    const info = await nanoRpc(loadNanoRpcKey(), { action: "block_info", hash: query, json_block: true }).catch(() => null);
    if (info?.contents) {
      const m = await raw();
      const poolByPub = new Map([...m.idx.getChainPools()].map(([t, p]) => [p, t]));
      const cls = classifyLink(info.contents.link ?? "", {
        amount: info.amount,
        representative: info.contents.representative,
        poolByPub,
      });
      return { type: "block", data: { hash: query, account: info.block_account, amount: info.amount, subtype: (info as any).subtype, classification: cls } };
    }
    return { type: "not-found", data: null };
  }
  // Name/symbol match. (Cast: the isNanoAddress guard above negative-narrows
  // an already-string value to `never` on the else path.)
  const m = await raw();
  const ql = (query as string).toLowerCase();
  const matches: any[] = [];
  for (const [tokenId, s] of m.state) {
    const row = m.meta.get(tokenId);
    if ((row?.name ?? "").toLowerCase().includes(ql) || (row?.symbol ?? "").toLowerCase().includes(ql)) {
      matches.push({ tokenId, ...meta(row), supply: s.supply.toString() });
    }
  }
  return { type: "tokens", data: matches };
}
