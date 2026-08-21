// Multi-token indexer. Reads Nano blocks through a BlockSource, decodes each
// block's `link` into { tokenId, op } (compact op-link), derives a launch's
// tokenId from its block hash, and folds everything into a MultiState.
//
// The op signer is the block's own account (block.account), not the account the
// indexer happened to be watching — so creator/buyer/seller are real.

import { multiEmpty, type MultiState } from "../core/multi";
import { tokenIdFromLaunchHash, type TokenId } from "../core/token";
import { decodeOpLink } from "../core/oplink";
import { commitLink, isCommitLink, verifyCommit } from "../core/commit";
import { isFragA, assembleFrag } from "../core/fraglink";
import {
  isImmutableAnchor,
  isSetAuthorityAnchorA,
  assembleSetAuthority,
  tokenIdOfAnchor,
  type MetaAnchor,
} from "../core/metaAnchor";
import type { Op } from "../core/ops";
import { replayMulti } from "./replay";
import type { BlockSource, NanoBlock } from "./blockSource";

export interface LaunchMeta {
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export type MetaResolver = (tokenId: TokenId) => LaunchMeta;

const EMPTY_META: LaunchMeta = { name: "", symbol: "", decimals: 6, image: "" };

/** Resolve launch metadata from an in-memory tokenId → meta map (tests/local). */
export function metaMapResolver(map: Map<string, LaunchMeta>): MetaResolver {
  return (tokenId) => map.get(tokenId) ?? EMPTY_META;
}

/** Resolve a commit-reveal link back to { tokenId, op }. */
export type CommitResolver = (link: string) => { tokenId: TokenId; op: Op } | null;

/** Resolve a tokenId to its XNO pool account public key (hex). */
export type PoolKeyResolver = (tokenId: TokenId) => string | null;

/** In-memory commitment resolver that re-verifies each hit. */
export function commitMapResolver(entries: { tokenId: TokenId; op: Op }[]): CommitResolver {
  const map = new Map(entries.map((e) => [commitLink(e.tokenId, e.op).toLowerCase(), e]));
  return (link) => {
    const e = map.get(link.toLowerCase());
    if (!e || !verifyCommit(e.tokenId, e.op, link)) return null;
    return e;
  };
}

export interface SyncResult {
  applied: number;
  invalid: number;
  reasons: string[];
}

export interface SellRecord {
  tokenId: TokenId;
  sender: string;
  tokens: bigint;
  minXno: bigint;
  hash: string;
}

export interface IndexedEvent {
  tokenId: TokenId;
  op: Op;
  sender: string;
  height: bigint;
  timestamp?: number;
  hash: string;
  /** All carrier block hashes when the op spans multiple blocks (fragment
   * pairs: [A, B]); absent for single-block ops. Explorer metadata only —
   * never part of consensus state. */
  carriers?: string[];
}

/**
 * Canonical, indexer-independent event order. `height` is a PER-ACCOUNT Nano
 * chain height, so equal heights across different accounts are the common case;
 * ordering ties by input/enumeration order is non-deterministic (two indexers
 * that discover accounts in a different order would diverge). We tie-break on
 * the block hash — a globally unique, consensus-defined value — so every honest
 * indexer folds the same blocks into byte-identical state. Returns 0 only for
 * the same block (same hash), never relying on sort stability.
 */
export function canonicalOrder(a: IndexedEvent, b: IndexedEvent): number {
  if (a.height !== b.height) return a.height < b.height ? -1 : 1;
  if (a.hash === b.hash) return 0;
  return a.hash < b.hash ? -1 : 1;
}

/** One account chain, fragment-aware decoded: each entry is a routed event
 * plus the op-carrier block's `previous` (for deposit value-binding). */
export interface DecodedChain {
  events: { ev: IndexedEvent; prev: string }[];
  byHash: Map<string, NanoBlock>;
  anchors: MetaAnchor[]; // metadata-authority anchors found on this chain
}

/**
 * Pass-1 pool discovery: a token's pool pubkey is the `link` of the deposit
 * that its FIRST (canonical order) creator-signed seedLiq chains from.
 * First-wins and immutable thereafter; a non-creator can never establish a
 * pool (the launch signer is authoritative), and every honest indexer
 * converges on the same map because inputs and ordering are chain-defined.
 */
export function derivePoolKeysFromChain(chains: Map<string, DecodedChain>): Map<string, string> {
  const creators = new Map<string, string>();
  const candidates: { tokenId: string; sender: string; height: bigint; hash: string; poolPub: string }[] = [];
  for (const { events, byHash } of chains.values()) {
    for (const { ev, prev } of events) {
      if (ev.op.kind === "launch") creators.set(ev.tokenId, ev.sender);
      if (ev.op.kind === "seedLiq") {
        const dep = byHash.get(prev);
        if (dep && BigInt(dep.amount ?? "0") > 0n) {
          candidates.push({ tokenId: ev.tokenId, sender: ev.sender, height: ev.height, hash: ev.hash, poolPub: dep.link });
        }
      }
    }
  }
  candidates.sort((a, b) =>
    a.height !== b.height ? (a.height < b.height ? -1 : 1) : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
  );
  const pools = new Map<string, string>();
  for (const c of candidates) {
    if (pools.has(c.tokenId)) continue;
    if (creators.get(c.tokenId) !== c.sender) continue;
    pools.set(c.tokenId, c.poolPub.toLowerCase());
  }
  return pools;
}

export class MultiIndexer {
  private state: MultiState = multiEmpty();

  constructor(
    private source: BlockSource,
    private meta: MetaResolver = () => EMPTY_META,
    private commit: CommitResolver = () => null,
    private poolKey: PoolKeyResolver = () => null
  ) {}

  getState(): MultiState {
    return this.state;
  }

  /** Decode a block into a routed event, or null if it carries no op. */
  decode(block: NanoBlock): IndexedEvent | null {
    // Op blocks are 1-raw data sends. Value transfers (buy deposits, plain sends)
    // have a different native amount, and receive/open blocks carry amount 0 —
    // none of these can be an op, so a random destination pubkey never collides
    // with a valid opcode.
    if (block.amount != null && BigInt(block.amount) !== 1n) return null;
    let tokenId: TokenId;
    let op: Op;
    if (isCommitLink(block.link)) {
      const r = this.commit(block.link);
      if (!r) return null;
      tokenId = r.tokenId;
      op = r.op;
    } else {
      try {
        const d = decodeOpLink(block.link);
        tokenId = d.tokenId;
        op = d.op;
      } catch {
        return null;
      }
      if (op.kind === "launch") {
        tokenId = tokenIdFromLaunchHash(block.hash);
        op = { ...op, ...this.meta(tokenId) };
      }
    }
    const timestamp = block.timestamp ? Number(block.timestamp) : undefined;
    return { tokenId, op, sender: block.account, height: block.height, timestamp, hash: block.hash };
  }

  /** tokenId → pool pubkey (lowercase hex) derived from chain history by the
   * last collectEvents. Empty until a sync/collect has run. */
  private chainPools = new Map<string, string>();

  getChainPools(): Map<string, string> {
    return new Map(this.chainPools);
  }

  /** Metadata-authority anchors found by the last collectEvents. */
  private metaAnchors: MetaAnchor[] = [];

  getMetaAnchors(): MetaAnchor[] {
    return [...this.metaAnchors];
  }

  /** op hash → the pool deposit that value-bound it (explorer edges). */
  private depositEdges = new Map<string, { deposit: string; amountRaw: string }>();

  getDepositEdges(): Map<string, { deposit: string; amountRaw: string }> {
    return new Map(this.depositEdges);
  }

  /** Pull + decode all ops for the given accounts, in confirmation order.
   *
   * Two passes. Pass 1 derives each token's pool pubkey FROM CHAIN DATA: the
   * first (canonical order) creator-signed seedLiq that chains from a real
   * XNO send names the pool in that deposit's `link`. This makes replay
   * verifiable with zero secrets — POOL_SEED is only needed to SIGN payouts,
   * never to validate history. The injected `poolKey` resolver remains as a
   * fallback for tokens with no seed yet (bootstrap) and MUST agree with the
   * chain-derived key for serviced tokens (the sweep asserts this). */
  /** Fragment-aware decode of one account chain (no value binding yet). Frag
   * B blocks are consumed by their A so their bytes are never mis-decoded as
   * standalone ops; a dangling A is skipped deterministically. */
  private decodeChain(blocks: NanoBlock[]): DecodedChain {
    const byHash = new Map(blocks.map((b) => [b.hash, b]));
    const childByPrev = new Map<string, NanoBlock>();
    for (const b of blocks) childByPrev.set(b.previous, b);
    const consumed = new Set<string>();
    const events: { ev: IndexedEvent; prev: string }[] = [];
    const anchors: MetaAnchor[] = [];
    for (const block of blocks) {
      if (consumed.has(block.hash)) continue;
      const isOpCarrier = block.amount == null || BigInt(block.amount) === 1n;
      if (isOpCarrier && isImmutableAnchor(block.link)) {
        anchors.push({
          tokenId: tokenIdOfAnchor(block.link),
          kind: "immutable",
          sender: block.account,
          height: block.height,
          hash: block.hash,
        });
        continue;
      }
      if (isOpCarrier && isSetAuthorityAnchorA(block.link)) {
        const child = childByPrev.get(block.hash);
        if (!child) continue; // dangling A → wait for B
        if (child.amount != null && BigInt(child.amount) !== 1n) continue;
        try {
          const d = assembleSetAuthority(block.link, child.link);
          consumed.add(child.hash);
          anchors.push({
            tokenId: d.tokenId,
            kind: "setAuthority",
            newAuthority: d.newAuthority,
            sender: block.account,
            height: child.height,
            hash: child.hash,
          });
        } catch {
          /* malformed pair → deterministically ignored */
        }
        continue;
      }
      if (isOpCarrier && isFragA(block.link)) {
        const child = childByPrev.get(block.hash);
        if (!child) continue; // dangling A → wait for B
        if (child.amount != null && BigInt(child.amount) !== 1n) continue;
        let d: { tokenId: TokenId; op: Op };
        try {
          d = assembleFrag(block.link, child.link);
        } catch {
          continue; // malformed pair → deterministically ignored
        }
        consumed.add(child.hash);
        const timestamp = child.timestamp ? Number(child.timestamp) : undefined;
        // The op completes only at B: height/hash come from B so canonical
        // ordering is identical for every indexer.
        events.push({
          ev: {
            tokenId: d.tokenId,
            op: d.op,
            sender: block.account,
            height: child.height,
            timestamp,
            hash: child.hash,
            carriers: [block.hash, child.hash],
          },
          prev: block.previous,
        });
        continue;
      }
      const ev = this.decode(block);
      if (ev) events.push({ ev, prev: block.previous });
    }
    return { events, byHash, anchors };
  }

  /** Fragment-aware decoded chains per account (explorer/edge consumers). */
  async collectChains(accounts: string[]): Promise<Map<string, DecodedChain>> {
    const decoded = new Map<string, DecodedChain>();
    for (const account of accounts) decoded.set(account, this.decodeChain(await this.source.listBlocks(account)));
    return decoded;
  }

  async collectEvents(accounts: string[]): Promise<IndexedEvent[]> {
    const decoded = await this.collectChains(accounts);

    this.chainPools = derivePoolKeysFromChain(decoded);
    this.metaAnchors = [...decoded.values()].flatMap((d) => d.anchors);
    const poolOf = (tokenId: TokenId): string | null =>
      this.chainPools.get(tokenId) ?? this.poolKey?.(tokenId) ?? null;

    this.depositEdges = new Map();
    // A deposit may back AT MOST ONE value-bound op. On a linear Nano chain two
    // ops can't share a `previous`, but this guards against a forked/replayed
    // history double-crediting one deposit (defense-in-depth).
    const consumedDeposits = new Set<string>();
    const events: IndexedEvent[] = [];
    for (const { events: evs, byHash } of decoded.values()) {
      for (const { ev, prev } of evs) {
        if (ev.op.kind === "buy") {
          // Value-bound buy: the authoritative xno is the native amount of the
          // deposit block the op chains from (previous), not any declared value.
          const dep = byHash.get(prev);
          const amount = dep ? BigInt(dep.amount ?? "0") : 0n;
          const poolPub = poolOf(ev.tokenId);
          const routesToPool = Boolean(dep && poolPub && dep.link.toLowerCase() === poolPub.toLowerCase());
          if (!dep || amount <= 0n || !routesToPool || consumedDeposits.has(dep.hash)) continue; // malformed/reused → skip
          consumedDeposits.add(dep.hash);
          ev.op = { ...ev.op, xno: amount };
          this.depositEdges.set(ev.hash, { deposit: dep.hash, amountRaw: amount.toString() });
        } else if (ev.op.kind === "seedLiq" || ev.op.kind === "addLiq") {
          // Value-bound liquidity: pool XNO only ever credits from a real
          // chained deposit send to this token's pool — the deposit's native
          // amount is authoritative. Compact links declare xno=0 and get
          // deposit-bound here; a legacy commit-reveal declaration (xno>0)
          // without a backing deposit is skipped. Token-only adds pass as-is.
          const dep = byHash.get(prev);
          const amount = dep ? BigInt(dep.amount ?? "0") : 0n;
          const poolPub = poolOf(ev.tokenId);
          const routesToPool = Boolean(dep && poolPub && dep.link.toLowerCase() === poolPub.toLowerCase());
          if (routesToPool && amount > 0n && !consumedDeposits.has(dep!.hash)) {
            consumedDeposits.add(dep!.hash);
            ev.op = { ...ev.op, xno: amount };
            this.depositEdges.set(ev.hash, { deposit: dep!.hash, amountRaw: amount.toString() });
          } else if (ev.op.xno > 0n) {
            continue; // declared-but-unbacked → skip
          }
        }
        events.push(ev);
      }
    }
    return events.sort(canonicalOrder);
  }

  /** Pull blocks for the given accounts and fold them into a MultiState. */
  async sync(accounts: string[]): Promise<SyncResult> {
    const events = await this.collectEvents(accounts);
    const result = replayMulti(events);
    this.state = result.state;
    return {
      applied: events.length - result.invalid.length,
      invalid: result.invalid.length,
      reasons: result.invalid.map((r) => r.reason),
    };
  }

  /** Collect on-chain sell ops (with block hash, for payout idempotency). */
  async collectSells(accounts: string[]): Promise<SellRecord[]> {
    const out: SellRecord[] = [];
    for (const account of accounts) {
      for (const block of await this.source.listBlocks(account)) {
        const ev = this.decode(block);
        if (ev && ev.op.kind === "sell") {
          out.push({
            tokenId: ev.tokenId,
            sender: ev.sender,
            tokens: ev.op.tokens,
            minXno: ev.op.minXno,
            hash: block.hash,
          });
        }
      }
    }
    return out;
  }
}