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

export function loadCommits(): CommitMap {
  const list = loadJson<CommitEntry[]>("commits.json") ?? [];
  return new Map(list.map((e) => [commitLink(e.tokenId, e.op).toLowerCase(), e]));
}

/** Register a reveal and return the on-chain commit link to broadcast. */
export function registerCommit(tokenId: string, op: Op): string {
  const link = commitLink(tokenId, op);
  const map = loadCommits();
  map.set(link.toLowerCase(), { tokenId, op });
  saveJson("commits.json", [...map.values()]);
  return link;
}

/** A CommitResolver bound to the on-disk registry (re-verifies each hit). */
export function commitResolver() {
  const reg = loadCommits();
  return (link: string) => {
    const e = reg.get(link.toLowerCase());
    if (!e || !verifyCommit(e.tokenId, e.op, link)) return null;
    return e;
  };
}