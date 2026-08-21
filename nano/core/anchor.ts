// The protocol anchor account — trustless participant discovery.
//
// Every participating account sends a one-time 1-raw "hello" to ANCHOR before
// its first op; every token pool self-registers the same way, with its hello
// block's representative encoding the tokenId. Any indexer can then derive
// the full participant set from ANCHOR's chain + pendings in two fixed hops
// (anchor counterparties → pool counterparties) — no operator-maintained
// account list. The anchor's PRIVATE key is not load-bearing: it can only
// ever ADD watch candidates (used once to bootstrap legacy accounts), never
// censor — every op is still signature/deposit-validated on its own merits.
//
// Spam bound: each bloat entry costs an attacker an opened, funded account
// plus proof-of-work; a spam account with no decodable ops costs one scan.

import * as nanocurrency from "nanocurrency";

export const ANCHOR_ADDRESS = "nano_31tg1ui9ndq73m9ngd1im1ij6xxtkhd8zg9o196uxnruh3gecik7gi6m5mhw";
export const ANCHOR_PUB = "834E06E07A2EE50CCF472C1098211277BA93D66FB8F501C9BED31B785CC54245";

/** A pool hello sets its representative to tokenId ‖ 16 zero bytes. */
export function poolHelloRepPub(tokenId: string): string {
  return (tokenId + "0".repeat(32)).toLowerCase();
}

export function poolHelloRepAddress(tokenId: string): string {
  return nanocurrency.deriveAddress(poolHelloRepPub(tokenId), { useNanoPrefix: true });
}

/** Extract the tokenId from a hello representative (address or 64-hex), or
 * null if it isn't the pool-hello pattern. */
export function tokenIdFromHelloRep(rep: string): string | null {
  let pub = rep;
  if (!/^[0-9a-fA-F]{64}$/.test(pub)) {
    try {
      pub = nanocurrency.derivePublicKey(rep);
    } catch {
      return null;
    }
  }
  pub = pub.toLowerCase();
  const tokenId = pub.slice(0, 32);
  const pad = pub.slice(32);
  if (!/^0{32}$/.test(pad)) return null;
  if (/^0{32}$/.test(tokenId)) return null;
  return tokenId;
}
