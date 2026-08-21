// Domain-separated signing for token-thread comments. Same trust model as
// metaAuth: the author signs a blake2b digest with their Nano key; the domain
// prefix keeps comment signatures, metadata signatures, and real block
// signatures in disjoint digest spaces. The comment id is derived from the
// signature, so re-posting a captured comment is idempotent, not a replay.
//
// Browser-safe: TextEncoder + blakejs only.

import { blake2bHex } from "blakejs";

export const COMMENT_DOMAIN = "holdfun-comment-v1";
export const MAX_COMMENT_LEN = 280;

/** The 32-byte digest the author signs (64 hex, uppercase for nanocurrency). */
export function commentSignDigest(tokenId: string, time: number, text: string): string {
  const payload = [COMMENT_DOMAIN, tokenId.toLowerCase(), String(time), text].join("\n");
  return blake2bHex(new TextEncoder().encode(payload), undefined, 32).toUpperCase();
}

/** Deterministic comment id: same signed comment → same id (dedupe on store). */
export function commentId(signature: string): string {
  return blake2bHex(new TextEncoder().encode(signature.toLowerCase()), undefined, 16);
}
