// Commit-reveal registry. Ops that don't fit the compact op-link (two amounts:
// sell.minXno / seedLiq / addLiq / transfer) are committed on-chain and their
// full payload registered off-chain so the indexer can resolve them. The
// indexer always re-verifies `commitLink(tokenId, op) === link` before trusting
// a reveal.

import type { Op } from "../core/ops";
import { commitLink, verifyCommit } from "../core/commit";
import { loadJson, saveJson } from "./store";

export interface CommitEntry {
  tokenId: string;
  op: Op;
}

export type CommitMap = Map<string, CommitEntry>;

export async function loadCommits(): Promise<CommitMap> {
  const list = (await loadJson<CommitEntry[]>("commits")) ?? [];
  return new Map(list.map((e) => [commitLink(e.tokenId, e.op).toLowerCase(), e]));
}

// Bound the registry so an unauthenticated caller can't grow the blob without
// limit (it is read + rewritten in full on every register / resolve).
const MAX_COMMITS = 5000;

/** Register a reveal and return the on-chain commit link to broadcast. */
export async function registerCommit(tokenId: string, op: Op): Promise<string> {
  const link = commitLink(tokenId, op);
  const map = await loadCommits();
  map.delete(link.toLowerCase()); // move-to-end (most-recent wins)
  map.set(link.toLowerCase(), { tokenId, op });
  let entries = [...map.values()];
  if (entries.length > MAX_COMMITS) entries = entries.slice(entries.length - MAX_COMMITS);
  await saveJson("commits", entries);
  return link;
}

/** An async CommitResolver bound to the on-disk registry (re-verifies each hit). */
export async function commitResolver(): Promise<(link: string) => { tokenId: string; op: Op } | null> {
  const reg = await loadCommits();
  return (link: string) => {
    const e = reg.get(link.toLowerCase());
    if (!e || !verifyCommit(e.tokenId, e.op, link)) return null;
    return e;
  };
}