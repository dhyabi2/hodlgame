// Server-side implementation of SharedBlockCache (indexer/blockSource.ts),
// backed by the durable store. Injected into NanoRpcSource on the server only —
// the browser verifier never sees it. Everything is keyed monotonically so it
// can only move forward, which makes it safe (a stale entry can only ever be
// BEHIND, never wrong) and debuggable (inspectable, self-invalidating).

import { loadBlob, saveBlob } from "./store";
import type { SharedBlockCache, NanoBlock } from "../indexer/blockSource";

const fkey = (account: string) => `frontier:${account}`;
/** One blob holding EVERY account's tip. Reading 38 accounts' tips used to be
 * 38 round trips to the durable store; this makes it one. Per-account keys are
 * still written so nothing is lost if this index is missing, and an account the
 * index does not know is simply read the old way. */
const FRONTIER_INDEX = "frontier-index";
const bkey = (account: string, frontier: string) => `chain:${account}:${frontier}`;

// Tiny per-request in-memory shield so N accounts don't each re-read the store
// for the same key within one compute() — this instance is created per request.
export class StoreBlockCache implements SharedBlockCache {
  private frontierMem = new Map<string, { frontier: string; height: number } | null>();
  private index: Record<string, { frontier: string; height: number }> | null = null;
  private indexLoaded = false;
  private indexDirty = false;

  /** Load the all-accounts tip index once per instance (one store read). */
  private async ensureIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    try {
      const raw = await this.load(FRONTIER_INDEX);
      const p = raw ? JSON.parse(raw) : null;
      if (p && typeof p === "object") this.index = p as Record<string, { frontier: string; height: number }>;
    } catch {}
  }

  /** Persist the tip index once, after a fold — not once per account. */
  async flush(): Promise<void> {
    if (!this.indexDirty || !this.index) return;
    this.indexDirty = false;
    try { await this.save(FRONTIER_INDEX, JSON.stringify(this.index)); } catch {}
  }
  // Store fns are injectable purely so the monotonicity/round-trip guarantees
  // can be unit-tested against an in-memory backend; prod uses the durable store.
  constructor(
    private load: (k: string) => Promise<string | null> = loadBlob,
    private save: (k: string, v: string) => Promise<void> = saveBlob,
  ) {}

  async getFrontier(account: string): Promise<{ frontier: string; height: number } | null> {
    if (this.frontierMem.has(account)) return this.frontierMem.get(account)!;
    await this.ensureIndex();
    const fromIndex = this.index?.[account];
    if (fromIndex && typeof fromIndex.frontier === "string" && Number.isFinite(fromIndex.height)) {
      this.frontierMem.set(account, fromIndex);
      return fromIndex;
    }
    let v: { frontier: string; height: number } | null = null;
    try {
      const raw = await this.load(fkey(account));
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p.frontier === "string" && /^[0-9A-Fa-f]{64}$/.test(p.frontier) && Number.isFinite(p.height)) {
          v = { frontier: p.frontier, height: Number(p.height) };
        }
      }
    } catch {}
    this.frontierMem.set(account, v);
    return v;
  }

  async putFrontier(account: string, frontier: string, height: number): Promise<void> {
    // Monotonic: only write if strictly higher than what's stored (and our memo).
    const cur = await this.getFrontier(account);
    if (cur && cur.height >= height) return;
    const v = { frontier, height };
    this.frontierMem.set(account, v);
    await this.ensureIndex();
    this.index = { ...(this.index ?? {}), [account]: v };
    this.indexDirty = true; // written once by flush(), not once per account
    try { await this.save(fkey(account), JSON.stringify(v)); } catch {}
  }

  async getBlocks(account: string, frontier: string): Promise<NanoBlock[] | null> {
    try {
      const raw = await this.load(bkey(account, frontier));
      if (!raw) return null;
      const arr = JSON.parse(raw, (_k, val) => (typeof val === "string" && /^-?\d+n$/.test(val) ? BigInt(val.slice(0, -1)) : val));
      return Array.isArray(arr) ? (arr as NanoBlock[]) : null;
    } catch { return null; }
  }

  async putBlocks(account: string, frontier: string, blocks: NanoBlock[]): Promise<void> {
    // Blocks carry bigint height — serialize as "<n>n" so JSON round-trips it.
    try {
      const json = JSON.stringify(blocks, (_k, val) => (typeof val === "bigint" ? val.toString() + "n" : val));
      await this.save(bkey(account, frontier), json);
    } catch {}
  }
}
