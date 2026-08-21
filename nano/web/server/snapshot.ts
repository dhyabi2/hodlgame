// Epoch snapshots of the residual off-chain state (roadmap W4).
//
// Most off-chain state is chain-derived (settlement) or user-signed and
// re-verifiable (metadata, comments). What remains is AVAILABILITY: a
// successor needs a copy. A snapshot is the canonical serialization of the
// residual stores; its blake2b hash is anchored on-chain by a 1-raw send
// whose destination pubkey IS the hash (data-anchor burn from the anchor
// account). Anyone can then mirror snapshot files anywhere untrusted and
// verify them against the anchor chain. Purely additive — nothing in the
// serving path depends on snapshots existing.

import { blake2bHex } from "blakejs";
import { loadJson } from "./store";
import { canonicalize } from "../core/canonical";
import type { NanoBlock } from "../indexer/blockSource";

export interface Snapshot {
  json: string; // canonical serialization (stable key order, bigint-safe)
  hash: string; // blake2b-256, 64 hex — also the on-chain anchor link
}

export async function exportSnapshot(): Promise<Snapshot> {
  const payload = {
    version: 1,
    tokens: (await loadJson("tokens")) ?? {},
    comments: (await loadJson("comments")) ?? [],
    commits: (await loadJson("commits")) ?? [],
    hellos: (await loadJson("hellos")) ?? {},
  };
  const json = canonicalize(payload);
  const hash = blake2bHex(new TextEncoder().encode(json), undefined, 32);
  return { json, hash };
}

/** Verify a mirrored snapshot file against its claimed hash. */
export function verifySnapshotJson(json: string, hash: string): boolean {
  return blake2bHex(new TextEncoder().encode(json), undefined, 32).toLowerCase() === hash.toLowerCase();
}

/** Is this snapshot hash anchored on the given account chain? (Any send whose
 * link equals the hash — the 1-raw data-anchor burn.) */
export function isAnchored(blocks: NanoBlock[], hash: string): boolean {
  const h = hash.toLowerCase();
  return blocks.some((b) => b.subtype === "send" && b.link.toLowerCase() === h);
}
