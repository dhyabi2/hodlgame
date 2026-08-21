// Server-side enforcement of signed metadata updates.
//
// Authority model (chain-derived, Metaplex-style):
// - The on-chain creator of a token (launch block signer) is the natural
//   authority. When the indexer knows the creator, only that account (or an
//   authority it explicitly transferred to) may write.
// - Before the launch is indexed (RPC lag right after broadcast), the first
//   valid signer is accepted as a PROVISIONAL authority. The moment the
//   on-chain creator is known it overrides any provisional claim, so a
//   front-runner's spoof survives seconds at most — and once the real creator
//   writes (or transfers), the authority is LOCKED and provisional resolution
//   never applies again.
// - `makeImmutable` freezes the row forever (one-way, rug-resistant branding).
// - `setAuthority:<nano_addr>` hands control to a new account.

import * as nanocurrency from "nanocurrency";
import { metaFieldsHash, metaSignDigest, type MetaFields } from "../core/metaAuth";
import { isNanoAddress } from "./validate";

export interface MetaAuthRow {
  authority?: string;
  authorityLocked?: boolean;
  seq?: number;
  immutable?: boolean;
}

export interface SignedMetaUpdate {
  tokenId: string;
  meta: MetaFields; // MUST already be sanitized (sanitizeMeta) — the client signs sanitized fields
  account: string;
  signature: string;
  seq: number;
  action: string;
}

/** ed25519-blake2b check: does `signature` by `account` sign `digest` (64 hex)? */
export function verifyAccountSignature(account: string, signature: string, digest: string): boolean {
  if (!isNanoAddress(account)) return false;
  if (typeof signature !== "string" || !/^[0-9a-fA-F]{128}$/.test(signature)) return false;
  try {
    const publicKey = nanocurrency.derivePublicKey(account);
    return (nanocurrency as any).verifyBlock({ hash: digest, signature: signature.toUpperCase(), publicKey });
  } catch {
    return false;
  }
}

/** Pure signature check: does `signature` sign this exact update by `account`? */
export function verifyMetaSignature(u: SignedMetaUpdate): boolean {
  if (!Number.isSafeInteger(u.seq) || u.seq <= 0) return false;
  if (typeof u.action !== "string" || u.action.length > 80) return false;
  const digest = metaSignDigest(u.tokenId, u.seq, u.action, metaFieldsHash(u.meta));
  return verifyAccountSignature(u.account, u.signature, digest);
}

export type MetaDecision =
  | { ok: true; row: MetaAuthRow }
  | { ok: false; code: number; error: string };

/**
 * Chain-anchor gate (W4): once a token's launch is indexed, the two
 * irrecoverable actions are governed by ON-CHAIN anchors (core/metaAnchor.ts)
 * — the store merely syncs. `chain` is the chain-derived authority state
 * (null while the launch is unindexed → store-level rules apply alone).
 */
export function gateMetaAction(
  action: string,
  chain: import("../core/metaAnchor").MetaAuthorityState | null
): { ok: true } | { ok: false; code: number; error: string } {
  if (!chain) return { ok: true };
  if (chain.immutable) {
    // Only the one-time store-sync of an anchored freeze may still write.
    return action === "makeImmutable"
      ? { ok: true }
      : { ok: false, code: 403, error: "metadata is immutable (anchored on-chain)" };
  }
  if (action === "makeImmutable") {
    return { ok: false, code: 409, error: "broadcast the immutable anchor first (1-raw send, link = immutableAnchorLink(tokenId))" };
  }
  if (action.startsWith("setAuthority:")) {
    const target = action.slice("setAuthority:".length);
    if (chain.authority !== target) {
      return { ok: false, code: 409, error: "broadcast the setAuthority anchor first (on-chain authority governs)" };
    }
  }
  return { ok: true };
}

/**
 * Authorization policy. `prev` is the stored row (if any), `onchainCreator` is
 * the indexer's creator for this token (null if the launch isn't indexed yet).
 * Assumes the signature was already verified for `u.account`.
 */
export function decideMetaUpdate(
  u: SignedMetaUpdate,
  prev: MetaAuthRow | null,
  onchainCreator: string | null
): MetaDecision {
  if (prev?.immutable) return { ok: false, code: 403, error: "metadata is immutable" };

  const authority = prev?.authorityLocked
    ? prev.authority ?? onchainCreator ?? u.account
    : onchainCreator ?? prev?.authority ?? u.account;
  if (u.account !== authority) return { ok: false, code: 403, error: "not the token authority" };

  const prevSeq = prev?.seq ?? 0;
  if (u.seq <= prevSeq) return { ok: false, code: 409, error: "stale seq (replay?)" };

  // Locked once the chain-verified creator has acted (directly or via transfer).
  let locked = Boolean(prev?.authorityLocked) || (onchainCreator != null && u.account === onchainCreator);
  let nextAuthority = authority;
  let immutable = false;

  if (u.action === "makeImmutable") {
    immutable = true;
  } else if (u.action.startsWith("setAuthority:")) {
    const next = u.action.slice("setAuthority:".length);
    if (!isNanoAddress(next)) return { ok: false, code: 400, error: "setAuthority: invalid nano address" };
    nextAuthority = next;
  } else if (u.action !== "update") {
    return { ok: false, code: 400, error: "unknown action" };
  }

  return { ok: true, row: { authority: nextAuthority, authorityLocked: locked, seq: u.seq, immutable } };
}
