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

/** Pure signature check: does `signature` sign this exact update by `account`? */
export function verifyMetaSignature(u: SignedMetaUpdate): boolean {
  if (!isNanoAddress(u.account)) return false;
  if (typeof u.signature !== "string" || !/^[0-9a-fA-F]{128}$/.test(u.signature)) return false;
  if (!Number.isSafeInteger(u.seq) || u.seq <= 0) return false;
  if (typeof u.action !== "string" || u.action.length > 80) return false;
  const digest = metaSignDigest(u.tokenId, u.seq, u.action, metaFieldsHash(u.meta));
  try {
    const publicKey = nanocurrency.derivePublicKey(u.account);
    return (nanocurrency as any).verifyBlock({ hash: digest, signature: u.signature.toUpperCase(), publicKey });
  } catch {
    return false;
  }
}

export type MetaDecision =
  | { ok: true; row: MetaAuthRow }
  | { ok: false; code: number; error: string };

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
