// Pool custody rotation (VELA-style `legacy_pubkeys`). A token's pool address
// is otherwise immutable (first creator seed deposit's link). To migrate its
// custody — e.g. single-key POOL_SEED → a FROST group address — the CURRENT
// pool key announces a successor by sending a 1-raw block FROM the pool
// account with representative = ROTATE_MARKER and link = the successor pool
// pubkey. Because the block is on the pool's own chain, only the current pool
// controller can sign it — authorization is inherent. The indexer follows the
// chain P0 → P1 → … to the CURRENT address, keeping every prior address as
// LEGACY so historical deposits (value-bound to the old address) still
// validate on replay. Deterministic: a pure function of chain data.
//
// Browser-safe (nanocurrency only).

import * as nanocurrency from "nanocurrency";

// A well-known, unspendable marker account whose pubkey flags a pool-rotation
// block via the representative field (mirrors the anchor pool-hello pattern).
export const ROTATE_MARKER_PUB = "d0d0d0d0" + "00".repeat(28); // 32 bytes, distinctive, no known key

export function rotateMarkerAddress(): string {
  return nanocurrency.deriveAddress(ROTATE_MARKER_PUB, { useNanoPrefix: true });
}

/** Is `representative` the rotation marker? (address or 64-hex pubkey). */
export function isRotateRep(representative: string): boolean {
  const rep = representative ?? "";
  if (/^[0-9a-fA-F]{64}$/.test(rep)) return rep.toLowerCase() === ROTATE_MARKER_PUB;
  try {
    return nanocurrency.derivePublicKey(rep).toLowerCase() === ROTATE_MARKER_PUB;
  } catch {
    return false;
  }
}

export interface RotationBlock {
  fromPub: string; // current pool pubkey (lowercase hex) — the block's signer
  toPub: string; // successor pool pubkey (lowercase hex) — the block's link
  height: bigint;
  hash: string;
}

export interface RotatedPools {
  current: Map<string, string>; // tokenId → current pool pubkey (after rotations)
  accepted: Map<string, Set<string>>; // tokenId → {current} ∪ legacy — for value-binding
}

/**
 * Follow rotation chains from each token's initial pool. `initial` is the
 * seed-derived pool pubkey per token (first-seed-wins). `rotations` are all
 * rotation blocks seen, keyed by the signing pool's pubkey. First rotation per
 * pool (canonical order) wins; cycles are broken.
 */
export function applyRotations(initial: Map<string, string>, rotations: RotationBlock[]): RotatedPools {
  // fromPub → the single successor (earliest by height/hash if a key somehow
  // signed more than one — deterministic).
  const byFrom = new Map<string, RotationBlock>();
  for (const r of [...rotations].sort((a, b) =>
    a.height !== b.height ? (a.height < b.height ? -1 : 1) : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
  )) {
    if (!byFrom.has(r.fromPub)) byFrom.set(r.fromPub, r);
  }

  const current = new Map<string, string>();
  const accepted = new Map<string, Set<string>>();
  for (const [tokenId, p0] of initial) {
    const set = new Set<string>([p0]);
    let cur = p0;
    const seen = new Set<string>([p0]);
    while (byFrom.has(cur)) {
      const next = byFrom.get(cur)!.toPub;
      if (seen.has(next)) break; // cycle guard
      seen.add(next);
      set.add(next);
      cur = next;
    }
    current.set(tokenId, cur);
    accepted.set(tokenId, set);
  }
  return { current, accepted };
}
