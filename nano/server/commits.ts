// Commit-reveal registry. Ops that don't fit the compact op-link (two amounts:
// buy.minTokens / sell.minXno) are committed on-chain and their full payload
// registered off-chain so the indexer can resolve them. The indexer always
// re-verifies `commitLink(tokenId, op) === link` before trusting a reveal.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Op } from "../core/ops";
import { commitLink, verifyCommit } from "../core/commit";
import { stringify, parse } from "../core/json";

export interface CommitEntry {
  tokenId: string;
  op: Op;
}

export type CommitMap = Map<string, CommitEntry>;

function commitsFile(): string {
  return process.env.COMMITS_FILE ?? path.join(process.cwd(), ".commits.json");
}

export function loadCommits(): CommitMap {
  try {
    const list = parse<CommitEntry[]>(fs.readFileSync(commitsFile(), "utf-8"));
    return new Map(list.map((e) => [commitLink(e.tokenId, e.op).toLowerCase(), e]));
  } catch {
    return new Map();
  }
}

/** Register a reveal and return the on-chain commit link to broadcast. */
export function registerCommit(tokenId: string, op: Op): string {
  const link = commitLink(tokenId, op);
  const map = loadCommits();
  map.set(link.toLowerCase(), { tokenId, op });
  fs.writeFileSync(commitsFile(), stringify([...map.values()]));
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