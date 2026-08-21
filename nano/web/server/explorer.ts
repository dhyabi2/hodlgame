// Explorer engine (docs/EXPLORER-SPEC.md): delta-instrumented replay (H1),
// link classification (A3), and payout attribution (H4). All pure functions
// over chain-derived data — deltas and edges are never stored as truth, they
// re-derive deterministically on every request.

import { applyBlock, multiEmpty, type MultiState } from "../core/multi";
import type { State } from "../core/state";
import type { IndexedEvent } from "../indexer/multiIndexer";
import type { NanoBlock } from "../indexer/blockSource";
import { isCommitLink } from "../core/commit";
import { isFragA } from "../core/fraglink";
import { isImmutableAnchor, isSetAuthorityAnchorA, tokenIdOfAnchor } from "../core/metaAnchor";
import { ANCHOR_PUB, tokenIdFromHelloRep } from "../core/anchor";
import { decodeOpLink } from "../core/oplink";
import { OP_CODE } from "../core/ops";
import type { SellPayout } from "./analytics";

// ── H1: delta-instrumented replay ───────────────────────────────────────────

export interface AccountDelta {
  account: string;
  delta: string; // signed decimal (bigint)
}

export interface OpDelta {
  hash: string;
  tokenId: string;
  kind: string;
  sender: string;
  height: string;
  timestamp?: number;
  carriers?: string[];
  valid: boolean;
  reason?: string;
  /** Scalar token fields that changed: field → { before, after } (decimal). */
  fields: Record<string, { before: string; after: string }>;
  balances: AccountDelta[];
  staked: AccountDelta[];
}

const SCALARS: (keyof State)[] = [
  "supply",
  "creatorShare",
  "treasury",
  "poolXno",
  "poolTokens",
  "totalStaked",
  "rebateVault",
  "rewardPerShare",
];

function mapDeltas(before: Map<string, bigint> | undefined, after: Map<string, bigint> | undefined): AccountDelta[] {
  const out: AccountDelta[] = [];
  const keys = new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
  for (const k of keys) {
    const d = (after?.get(k) ?? 0n) - (before?.get(k) ?? 0n);
    if (d !== 0n) out.push({ account: k, delta: d.toString() });
  }
  return out.sort((a, b) => (a.account < b.account ? -1 : 1));
}

/** Fold events into state, emitting a per-op diff of the touched token. */
export function replayWithDeltas(events: IndexedEvent[]): { state: MultiState; deltas: OpDelta[] } {
  let state = multiEmpty();
  const deltas: OpDelta[] = [];
  for (const ev of events) {
    const before = state.get(ev.tokenId);
    const base: OpDelta = {
      hash: ev.hash,
      tokenId: ev.tokenId,
      kind: ev.op.kind,
      sender: ev.sender,
      height: ev.height.toString(),
      timestamp: ev.timestamp,
      carriers: ev.carriers,
      valid: true,
      fields: {},
      balances: [],
      staked: [],
    };
    let next: MultiState;
    try {
      next = applyBlock(state, ev);
    } catch (err) {
      deltas.push({ ...base, valid: false, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const after = next.get(ev.tokenId);
    for (const f of SCALARS) {
      const b = (before?.[f] as bigint | undefined) ?? 0n;
      const a = (after?.[f] as bigint | undefined) ?? 0n;
      if (b !== a) base.fields[f] = { before: b.toString(), after: a.toString() };
    }
    base.balances = mapDeltas(before?.balances, after?.balances);
    base.staked = mapDeltas(before?.staked, after?.staked);
    deltas.push(base);
    state = next;
  }
  return { state, deltas };
}

// ── A3: link classification ─────────────────────────────────────────────────

export interface LinkClass {
  kind:
    | "compact-op"
    | "commit-op"
    | "fragment-a"
    | "hello"
    | "pool-hello"
    | "meta-anchor-immutable"
    | "meta-anchor-set-authority"
    | "pool-deposit"
    | "send"
    | "unknown";
  opKind?: string; // for compact/fragment ops
  tokenId?: string; // when derivable from the link/context
}

/** Classify a block's link (pure; context maps sharpen the answer).
 * `poolByPub`: pool pubkey (lowercase) → tokenId. `representative` is the
 * block's own rep (pool hellos encode tokenId there). */
export function classifyLink(
  link: string,
  opts: { amount?: string; representative?: string; poolByPub?: Map<string, string> } = {}
): LinkClass {
  const l = (link ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(l)) return { kind: "unknown" };
  const isOneRaw = opts.amount == null || BigInt(opts.amount) === 1n;

  if (l === ANCHOR_PUB.toLowerCase()) {
    const tokenId = opts.representative ? tokenIdFromHelloRep(opts.representative) : null;
    return tokenId ? { kind: "pool-hello", tokenId } : { kind: "hello" };
  }
  const poolToken = opts.poolByPub?.get(l);
  if (poolToken && !isOneRaw) return { kind: "pool-deposit", tokenId: poolToken };

  if (isOneRaw) {
    if (isCommitLink(l)) return { kind: "commit-op" };
    if (isImmutableAnchor(l)) return { kind: "meta-anchor-immutable", tokenId: tokenIdOfAnchor(l) };
    if (isSetAuthorityAnchorA(l)) return { kind: "meta-anchor-set-authority", tokenId: tokenIdOfAnchor(l) };
    if (isFragA(l)) {
      const code = parseInt(l.slice(0, 2), 16) & 0x0f;
      const opKind = code === OP_CODE.transfer ? "transfer" : "sell";
      return { kind: "fragment-a", opKind, tokenId: l.slice(2, 34) };
    }
    try {
      const d = decodeOpLink(l);
      return { kind: "compact-op", opKind: d.op.kind, tokenId: d.op.kind === "launch" ? undefined : d.tokenId };
    } catch {
      /* not a compact op */
    }
  }
  return { kind: "send" };
}

// ── H4: payout attribution (which sells/refunds a pool send covered) ────────

export interface PayoutCoverage {
  sendHash: string;
  recipient: string;
  amountRaw: string;
  covers: { kind: "sell" | "refund"; hash?: string; amountRaw: string }[];
}

/**
 * Replay the pool's outgoing sends against the canonical obligation stream —
 * the SAME positional netting rule settlement uses (settled.ts), so the
 * attribution is exactly what the payer computed. Per recipient: sells in
 * event order first, then the refund balance.
 */
export function attributePoolSends(
  poolBlocks: NanoBlock[],
  sells: SellPayout[],
  refunds: Map<string, bigint>,
  pubToAddress: (pub: string) => string
): PayoutCoverage[] {
  // Per-recipient obligation queues, in canonical (event) order.
  const queues = new Map<string, { kind: "sell" | "refund"; hash?: string; left: bigint }[]>();
  for (const s of sells) {
    const q = queues.get(s.to) ?? [];
    q.push({ kind: "sell", hash: s.hash, left: s.amountRaw });
    queues.set(s.to, q);
  }
  for (const [to, owed] of refunds) {
    const q = queues.get(to) ?? [];
    q.push({ kind: "refund", left: owed });
    queues.set(to, q);
  }

  const out: PayoutCoverage[] = [];
  const sends = poolBlocks
    .filter((b) => b.subtype === "send" && /^[0-9a-fA-F]{64}$/.test(b.link) && BigInt(b.amount ?? "0") > 0n)
    .sort((a, b) => (a.height < b.height ? -1 : 1));
  for (const b of sends) {
    const recipient = pubToAddress(b.link.toLowerCase());
    const q = queues.get(recipient);
    if (!q) continue; // e.g. the 1-raw anchor hello, or an unrelated send
    let remaining = BigInt(b.amount ?? "0");
    const covers: PayoutCoverage["covers"] = [];
    while (remaining > 0n && q.length) {
      const ob = q[0];
      const take = remaining < ob.left ? remaining : ob.left;
      covers.push({ kind: ob.kind, hash: ob.hash, amountRaw: take.toString() });
      ob.left -= take;
      remaining -= take;
      if (ob.left === 0n) q.shift();
    }
    if (covers.length) out.push({ sendHash: b.hash, recipient, amountRaw: String(b.amount), covers });
  }
  return out;
}
