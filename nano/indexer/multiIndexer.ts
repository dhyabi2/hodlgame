// Multi-token indexer. Reads Nano blocks through a BlockSource, decodes each
// block's `link` into { tokenId, op } (compact op-link), derives a launch's
// tokenId from its block hash, and folds everything into a MultiState.
//
// The op signer is the block's own account (block.account), not the account the
// indexer happened to be watching — so creator/buyer/seller are real.

import * as nanocurrency from "nanocurrency";
import { multiEmpty, type MultiState } from "../core/multi";
import { tokenIdFromLaunchHash, type TokenId } from "../core/token";
import { decodeOpLink } from "../core/oplink";
import { isRotateRep, applyRotations, type RotationBlock } from "../core/rotate";
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
  /** Sub-order within one block: 0 (default) = the op itself, 1 = the block's
   * signed-balance observation. Consensus-relevant tiebreak — the op always
   * folds before its own block's balance is checked against the floors. */
  sub?: number;
  /** Lamport causal clock over the block-lattice (see lamportClocks). Primary
   * sort key when present — orders events by Nano's OWN causality instead of
   * raw per-account height. */
  lam?: bigint;
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
  // Causal first: Lamport clocks derived from the lattice itself (a receive
  // happens-after its source send) order events across accounts the way value
  // actually flowed — a wallet funded after a launch sorts after it, however
  // young its chain is. Height alone made a fresh wallet's whole history sort
  // before an old wallet's, structurally mis-pricing cross-wallet trades.
  const la = a.lam ?? 0n, lb = b.lam ?? 0n;
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.height !== b.height) return a.height < b.height ? -1 : 1;
  if (a.hash === b.hash) return (a.sub ?? 0) - (b.sub ?? 0);
  return a.hash < b.hash ? -1 : 1;
}

/**
 * Lamport clocks for every decoded block: lam(b) = 1 + max(lam(previous),
 * lam(source send) if b is a receive/open). Pure function of the block set —
 * deterministic for every replayer — and computed iteratively (monotone
 * fixpoint over height-ordered chains), so cross-chain funding edges deepen
 * the clock without recursion. Unknown sources (external funders) count as 0.
 */
export function lamportClocks(chains: Map<string, DecodedChain>): Map<string, bigint> {
  const all = new Map<string, NanoBlock>();
  for (const { byHash } of chains.values()) for (const b of byHash.values()) all.set(b.hash, b);
  const lam = new Map<string, bigint>();
  const isHex64 = (s: string) => /^[0-9a-fA-F]{64}$/.test(s);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { byHash } of chains.values()) {
      const ordered = [...byHash.values()].sort((x, y) => (x.height < y.height ? -1 : 1));
      for (const b of ordered) {
        let m = lam.get(b.previous) ?? 0n;
        if ((b.subtype === "receive" || b.subtype === "open") && isHex64(b.link)) {
          const s = lam.get(b.link.toUpperCase()) ?? lam.get(b.link.toLowerCase()) ?? lam.get(b.link) ?? 0n;
          if (s > m) m = s;
        }
        const v = m + 1n;
        if ((lam.get(b.hash) ?? -1n) < v) {
          lam.set(b.hash, v);
          changed = true;
        }
      }
    }
  }
  return lam;
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
/** Collect pool-rotation announcements from all chains: a 1-raw block on a
 * pool's own chain with representative = ROTATE_MARKER and link = successor
 * pubkey. Signed by the pool account, so authorization is inherent. */
export function collectRotationsFromChain(chains: Map<string, DecodedChain>): RotationBlock[] {
  const out: RotationBlock[] = [];
  for (const { byHash } of chains.values()) {
    for (const b of byHash.values()) {
      if (!isRotateRep(b.representative)) continue;
      if (!/^[0-9a-fA-F]{64}$/.test(b.link)) continue;
      let fromPub: string;
      try {
        fromPub = nanocurrency.derivePublicKey(b.account).toLowerCase();
      } catch {
        continue;
      }
      out.push({ fromPub, toPub: b.link.toLowerCase(), height: b.height, hash: b.hash });
    }
  }
  return out;
}

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
        // Overlay off-chain DISPLAY meta (name/symbol/image) only. `decimals`
        // is consensus-bound from the link (decodeOpLink) and must NOT be
        // overridden by the mutable registry — an exchange can pin it.
        const m = this.meta(tokenId);
        op = { ...op, name: m.name, symbol: m.symbol, image: m.image };
      }
    }
    const timestamp = block.timestamp ? Number(block.timestamp) : undefined;
    return { tokenId, op, sender: block.account, height: block.height, timestamp, hash: block.hash };
  }

  /** tokenId → CURRENT pool pubkey (lowercase hex), after following custody
   * rotations. Empty until a sync/collect has run. */
  private chainPools = new Map<string, string>();

  getChainPools(): Map<string, string> {
    return new Map(this.chainPools);
  }

  /** tokenId → the SET of accepted pool pubkeys (current ∪ legacy). Deposits
   * value-bind against any address in the set, so a custody rotation doesn't
   * strand historical buys. */
  private chainPoolSet = new Map<string, Set<string>>();

  getChainPoolSet(): Map<string, Set<string>> {
    return new Map([...this.chainPoolSet].map(([k, v]) => [k, new Set(v)]));
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
        // Buys/sells carry the SIGNED balance of their completing block —
        // consensus input for direct-settlement collateral checks and
        // actual-balance exit netting.
        if ((d.op.kind === "sell" || d.op.kind === "buy") && child.balance != null) {
          d.op = { ...d.op, balanceAt: BigInt(child.balance) };
        }
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
      if (ev) {
        if ((ev.op.kind === "sell" || ev.op.kind === "buy") && block.balance != null) {
          ev.op = { ...ev.op, balanceAt: BigInt(block.balance) };
        }
        events.push({ ev, prev: block.previous });
      }
    }
    return { events, byHash, anchors };
  }

  /** Fragment-aware decoded chains per account (explorer/edge consumers).
   *
   * Block fetches run with bounded concurrency (each account's listBlocks is an
   * independent RPC round-trip), then the Map is rebuilt in the ORIGINAL
   * `accounts` order. decodeChain is a pure function of one account's own
   * locally-verified blocks with zero cross-account dependency, and downstream
   * consumers either sort (canonicalOrder) or are order-independent — so the
   * folded state is byte-identical; only wall-clock changes. Was O(N) serial. */
  async collectChains(accounts: string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, DecodedChain>> {
    // Batch-resolve every account's best frontier in ~3 RPC calls (if the source
    // supports it) so the per-account fetches below skip their own frontier
    // probes. Best-effort — a source without warmFrontiers, or an account it
    // can't resolve, just takes the per-account path in listBlocks unchanged.
    // NOTE: an accounts_frontiers batch prefetch was tried here but caused a
    // cold-start latency regression (its in-flight promises competed with the
    // per-account fetches on a cold serverless instance), so it's disabled. The
    // per-account best-view frontier in listBlocks + the module-level
    // FRONTIER_CACHE + the request-scoped block memo are the kept, safe wins.
    const CONCURRENCY = 10;
    const out: (DecodedChain | null)[] = new Array(accounts.length).fill(null);
    let cursor = 0;
    let done = 0;
    onProgress?.(0, accounts.length);
    const worker = async () => {
      for (;;) {
        const i = cursor++; // atomic in single-threaded JS (no await before use)
        if (i >= accounts.length) return;
        out[i] = this.decodeChain(await this.source.listBlocks(accounts[i]));
        onProgress?.(++done, accounts.length); // report as each account's chain lands
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker));
    const decoded = new Map<string, DecodedChain>();
    for (let i = 0; i < accounts.length; i++) decoded.set(accounts[i], out[i]!);
    return decoded;
  }

  async collectEvents(accounts: string[], onProgress?: (done: number, total: number) => void): Promise<IndexedEvent[]> {
    const decoded = await this.collectChains(accounts, onProgress);

    // Initial (first-seed-wins) pool per token, then follow custody rotations.
    const initial = derivePoolKeysFromChain(decoded);
    const rotations = collectRotationsFromChain(decoded);
    const rotated = applyRotations(initial, rotations);
    this.chainPools = rotated.current; // current pool (custody assert / new payouts)
    this.chainPoolSet = rotated.accepted; // current ∪ legacy (value-binding)
    this.metaAnchors = [...decoded.values()].flatMap((d) => d.anchors);
    // A deposit value-binds if it routes to ANY accepted (current/legacy) pool;
    // fall back to the injected resolver for bootstrap-before-seed.
    const routesToPool = (tokenId: TokenId, depLink: string): boolean => {
      const set = this.chainPoolSet.get(tokenId);
      const l = depLink.toLowerCase();
      if (set && set.has(l)) return true;
      const boot = this.poolKey?.(tokenId);
      return Boolean(boot && boot.toLowerCase() === l);
    };

    this.depositEdges = new Map();
    // Causal clocks for the whole decoded lattice (canonicalOrder key).
    const lamMap = lamportClocks(decoded);
    // Direct-Settlement tokens (consensus-bound in the launch link, 0x0b):
    // their buys/seeds bind differently — no pool account exists at all.
    const directSet = new Set<TokenId>();
    for (const { events: evs } of decoded.values()) {
      for (const { ev } of evs) {
        if (ev.op.kind === "launch" && ev.op.direct) directSet.add(ev.tokenId);
      }
    }
    // A deposit may back AT MOST ONE value-bound op. On a linear Nano chain two
    // ops can't share a `previous`, but this guards against a forked/replayed
    // history double-crediting one deposit (defense-in-depth).
    const consumedDeposits = new Set<string>();
    const events: IndexedEvent[] = [];
    for (const { events: evs, byHash } of decoded.values()) {
      for (const { ev, prev } of evs) {
        if (ev.op.kind === "buy" && directSet.has(ev.tokenId)) {
          if (ev.op.xno > 0n) {
            // Frag-declared self-earmark buy: no deposit — the state machine
            // checks the declared xno against the signed carrier balance
            // (balanceAt) and the queue-empty rule. depositTo stays unset.
          } else {
            // Queue-routed buy: the chained deposit is a real send whose
            // DESTINATION (a queued seller) is the routing fact — attached
            // here, validated against the queue by the state machine.
            const dep = byHash.get(prev);
            const amount = dep ? BigInt(dep.amount ?? "0") : 0n;
            if (!dep || amount <= 0n || dep.subtype !== "send" || consumedDeposits.has(dep.hash)) continue;
            consumedDeposits.add(dep.hash);
            let payee: string;
            try {
              payee = nanocurrency.deriveAddress(dep.link.toLowerCase(), { useNanoPrefix: true });
            } catch {
              continue;
            }
            ev.op = { ...ev.op, xno: amount, depositTo: payee };
            this.depositEdges.set(ev.hash, { deposit: dep.hash, amountRaw: amount.toString() });
          }
        } else if (ev.op.kind === "buy") {
          // Value-bound buy: the authoritative xno is the native amount of the
          // deposit block the op chains from (previous), not any declared value.
          const dep = byHash.get(prev);
          const amount = dep ? BigInt(dep.amount ?? "0") : 0n;
          const routed = Boolean(dep && routesToPool(ev.tokenId, dep.link));
          if (!dep || amount <= 0n || !routed || consumedDeposits.has(dep.hash)) continue; // malformed/reused → skip
          consumedDeposits.add(dep.hash);
          ev.op = { ...ev.op, xno: amount };
          this.depositEdges.set(ev.hash, { deposit: dep.hash, amountRaw: amount.toString() });
        } else if ((ev.op.kind === "seedLiq" || ev.op.kind === "addLiq") && directSet.has(ev.tokenId)) {
          // Direct token liquidity is VIRTUAL: the frag-declared xno passes
          // through as-is (it claims no real money — see state.ts), and no
          // deposit is consumed or required.
        } else if (ev.op.kind === "seedLiq" || ev.op.kind === "addLiq") {
          // Value-bound liquidity: pool XNO only ever credits from a real
          // chained deposit send to this token's pool — the deposit's native
          // amount is authoritative. Compact links declare xno=0 and get
          // deposit-bound here; a legacy commit-reveal declaration (xno>0)
          // without a backing deposit is skipped. Token-only adds pass as-is.
          const dep = byHash.get(prev);
          const amount = dep ? BigInt(dep.amount ?? "0") : 0n;
          const routed = Boolean(dep && routesToPool(ev.tokenId, dep.link));
          if (routed && amount > 0n && !consumedDeposits.has(dep!.hash)) {
            consumedDeposits.add(dep!.hash);
            ev.op = { ...ev.op, xno: amount };
            this.depositEdges.set(ev.hash, { deposit: dep!.hash, amountRaw: amount.toString() });
          } else if (ev.op.xno > 0n) {
            continue; // declared-but-unbacked → skip
          }
        }
        ev.lam = lamMap.get(ev.hash) ?? 0n;
        events.push(ev);
      }
    }
    // Signed-balance observations: with any direct token live, every block of
    // every watched chain contributes its balance as a consensus event (sub 1,
    // AFTER the block's own op). The multi-state router prorates each account's
    // observed balance across its floors and voids defected collateral — this
    // is what makes earmarks trustworthy without locking anything.
    if (directSet.size > 0) {
      // A HEAD observation must fold strictly AFTER every real event so it can
      // re-check a floor an op anchored late. Consensus replay defers an op
      // that is invalid in canonical order (e.g. a self-earmark buy sorted
      // before its token's seed) and drains it once it becomes valid — which
      // can be after that account's own last balance block. A point-in-time
      // per-block observation taken before the floor exists is a no-op, so the
      // established floor would escape all checks. The head observation, pinned
      // to lam = maxLam + 1 (greater than any real event), guarantees each
      // account's real current balance is validated against whatever floor it
      // ends up carrying. Deterministic: maxLam is a pure function of the block
      // set, and head selection ties on (height, hash) like every other event.
      let maxLam = 0n;
      for (const v of lamMap.values()) if (v > maxLam) maxLam = v;
      const headLam = maxLam + 1n;
      for (const { byHash } of decoded.values()) {
        let head: NanoBlock | null = null;
        for (const b of byHash.values()) {
          if (b.balance == null) continue;
          events.push({
            tokenId: "",
            op: { kind: "balance", raw: BigInt(b.balance) },
            sender: b.account,
            height: b.height,
            hash: b.hash,
            sub: 1,
            lam: lamMap.get(b.hash) ?? 0n,
          });
          if (!head || b.height > head.height) head = b;
        }
        if (head) {
          events.push({
            tokenId: "",
            op: { kind: "balance", raw: BigInt(head.balance!) },
            sender: head.account,
            height: head.height,
            hash: head.hash,
            sub: 2,
            lam: headLam,
          });
        }
      }
    }
    return events.sort(canonicalOrder);
  }

  /** Pull blocks for the given accounts and fold them into a MultiState. */
  async sync(accounts: string[], onProgress?: (done: number, total: number) => void): Promise<SyncResult> {
    const events = await this.collectEvents(accounts, onProgress);
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