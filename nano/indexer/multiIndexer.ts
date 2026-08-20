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
}

export class MultiIndexer {
  private state: MultiState = multiEmpty();

  constructor(
    private source: BlockSource,
    private meta: MetaResolver = () => EMPTY_META,
    private commit: CommitResolver = () => null
  ) {}

  getState(): MultiState {
    return this.state;
  }

  /** Decode a block into a routed event, or null if it carries no op. */
  decode(block: NanoBlock): IndexedEvent | null {
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

  /** Pull + decode all ops for the given accounts, in confirmation order. */
  async collectEvents(accounts: string[]): Promise<IndexedEvent[]> {
    const events: IndexedEvent[] = [];
    for (const account of accounts) {
      for (const block of await this.source.listBlocks(account)) {
        const ev = this.decode(block);
        if (ev) events.push(ev);
      }
    }
    return events.sort((a, b) => (a.height < b.height ? -1 : 1));
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