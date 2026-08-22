// Binary Merkle tree over the ledger's balances (exchange kit E1). Lets a
// light verifier confirm ONE account's token balance in O(log N) against a
// balance root, instead of replaying the whole ledger for every balance.
//
// TRUST MODEL (read carefully): the balance root is a PURE FUNCTION of the
// replayed balances. Those balances ARE in the consensus state projection
// (canonical.ts), but the root itself is NOT a separate consensus value and is
// NOT committed by the state root. So a balance root is only trustworthy when
// YOU recompute it from YOUR OWN replay (verify.ts prints it alongside the
// state root for exactly this). NEVER accept a server-supplied balance root at
// face value and verify inclusion proofs against it — a dishonest operator
// could publish a fabricated root that "proves" any inflated balance. The
// security is: replay chain -> derive balances -> compute this root yourself ->
// then O(log N) inclusion proofs are cheap and sound. Browser-safe (blakejs).

import { blake2bHex } from "blakejs";
import type { MultiState } from "./multi";

const enc = new TextEncoder();
function h(s: string): string {
  return blake2bHex(enc.encode(s), undefined, 32);
}

/** Canonical leaf string for one holding. Sorted lex/ically so every builder
 * produces the identical tree. */
export function balanceLeaf(tokenId: string, account: string, balance: string): string {
  return `${tokenId.toLowerCase()}|${account}|${balance}`;
}

export interface MerkleProof {
  leaf: string;
  index: number;
  siblings: string[]; // bottom-up sibling hashes
  root: string;
}

/** Hash of two ordered children (position-encoded so left/right can't swap). */
function hashPair(left: string, right: string): string {
  return h(`\x01${left}${right}`);
}

/** Build the tree over already-sorted leaf STRINGS. Returns the root and the
 * layer hashes (bottom-up). Odd nodes are promoted (hashed with themselves). */
export function buildMerkle(leaves: string[]): { root: string; layers: string[][] } {
  if (leaves.length === 0) return { root: h("\x00empty"), layers: [[]] };
  let layer = leaves.map((l) => h(`\x00${l}`)); // leaf-hash domain-separated from inner
  const layers: string[][] = [layer];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i]; // promote odd
      next.push(hashPair(left, right));
    }
    layers.push(next);
    layer = next;
  }
  return { root: layer[0], layers };
}

/** Inclusion proof for the leaf at `index` (index into the sorted leaf list). */
export function merkleProof(leaves: string[], index: number): MerkleProof {
  const { root, layers } = buildMerkle(leaves);
  const siblings: string[] = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const sibIdx = idx % 2 === 0 ? Math.min(idx + 1, layer.length - 1) : idx - 1;
    siblings.push(layer[sibIdx]);
    idx = Math.floor(idx / 2);
  }
  return { leaf: leaves[index], index, siblings, root };
}

/** Verify an inclusion proof — O(log N), no ledger, no replay. */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  let node = h(`\x00${proof.leaf}`);
  let idx = proof.index;
  for (const sib of proof.siblings) {
    node = idx % 2 === 0 ? hashPair(node, sib) : hashPair(sib, node);
    idx = Math.floor(idx / 2);
  }
  return node.toLowerCase() === proof.root.toLowerCase();
}

/** Sorted balance leaves for the whole ledger (every non-zero holding). */
export function balanceLeaves(state: MultiState): string[] {
  const out: string[] = [];
  for (const [tokenId, s] of state) {
    for (const [account, bal] of s.balances) {
      if (bal > 0n) out.push(balanceLeaf(tokenId, account, bal.toString()));
    }
  }
  return out.sort();
}

/** The balance commitment root over the whole ledger. */
export function balanceRoot(state: MultiState): string {
  return buildMerkle(balanceLeaves(state)).root;
}

/** Prove one account's balance for one token (or null if it holds none). */
export function proveBalance(state: MultiState, tokenId: string, account: string): MerkleProof | null {
  const leaves = balanceLeaves(state);
  const s = state.get(tokenId);
  const bal = s?.balances.get(account) ?? 0n;
  if (bal <= 0n) return null;
  const leaf = balanceLeaf(tokenId, account, bal.toString());
  const index = leaves.indexOf(leaf);
  if (index < 0) return null;
  return merkleProof(leaves, index);
}
