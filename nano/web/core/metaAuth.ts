// Domain-separated signing for off-chain token-metadata updates.
//
// The registry (name/image/socials) lives off-chain, but authority over it is
// the on-chain launch key: an update must be signed by the token's creator
// account (ed25519-blake2b, the same key that signs Nano blocks). The signed
// digest is blake2b over a domain-prefixed payload — the "holdfun-meta-v1"
// prefix guarantees the digest can never equal a real Nano block hash (those
// are blake2b over binary block fields), so a metadata signature can never be
// replayed as a spend, and a block signature can never be replayed as a
// metadata update.
//
// Replay protection: each update carries a strictly-increasing `seq` (clients
// use Date.now()); the registry stores the last accepted seq per token and
// rejects anything not greater.
//
// Browser-safe: TextEncoder + blakejs only (no Buffer, no node APIs).

import { blake2bHex } from "blakejs";

export const META_DOMAIN = "holdfun-meta-v1";

export interface MetaFields {
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

/** Actions an authority can sign. `setAuthority:<nano_addr>` hands control to
 * a new account; `makeImmutable` freezes the metadata forever (one-way). */
export type MetaAction = "update" | "makeImmutable" | `setAuthority:${string}`;

/** Canonical hash of the metadata fields: fixed order, NUL-separated, so the
 * signature covers exactly what the registry will store. Sign the SANITIZED
 * fields (sanitizeMeta) — server and client must hash identical values. */
export function metaFieldsHash(m: MetaFields): string {
  const canon = [
    m.name,
    m.symbol,
    String(m.decimals),
    m.image,
    m.description ?? "",
    m.website ?? "",
    m.twitter ?? "",
    m.telegram ?? "",
  ].join("\u0000");
  return blake2bHex(new TextEncoder().encode(canon), undefined, 32);
}

/** The 32-byte digest the authority signs (64 hex, uppercase for nanocurrency). */
export function metaSignDigest(tokenId: string, seq: number, action: string, fieldsHash: string): string {
  const payload = [META_DOMAIN, tokenId.toLowerCase(), String(seq), action, fieldsHash.toLowerCase()].join("\n");
  return blake2bHex(new TextEncoder().encode(payload), undefined, 32).toUpperCase();
}
