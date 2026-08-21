// Off-chain token metadata registry. The compact launch op carries only the
// supply; name/symbol/decimals/image + socials are published off-chain (durable
// store) and fed back through the indexer's MetaResolver. Keyed by tokenId.
//
// Writes are authenticated: each row also stores the metadata authority
// (creator account, chain-derived), the last accepted signature seq, and the
// immutable flag — see metaAuth.ts. loadRegistry() strips those auth fields
// (sanitizeMeta picks only display fields), so the indexer sees plain meta.

import type { LaunchMeta } from "../indexer/multiIndexer";
import { loadJson, saveJson } from "./store";
import { isTokenId, sanitizeMeta } from "./validate";
import type { MetaAuthRow } from "./metaAuth";

export const EMPTY_META: LaunchMeta = { name: "", symbol: "", decimals: 6, image: "" };

export type StoredMetaRow = LaunchMeta & MetaAuthRow;

/** tokenId → metadata. Returns an empty map if no registry exists yet. */
export async function loadRegistry(): Promise<Map<string, LaunchMeta>> {
  const raw = (await loadJson<Record<string, StoredMetaRow>>("tokens")) ?? {};
  const out = new Map<string, LaunchMeta>();
  // Sanitize on read too, so any pre-existing bad rows (e.g. decimals=-1, which
  // would crash analytics) can never take down the feed.
  for (const [id, meta] of Object.entries(raw)) {
    if (!isTokenId(id)) continue;
    out.set(id, sanitizeMeta(meta));
  }
  return out;
}

/** Full stored row (meta + auth fields) for one token, or null. */
export async function loadMetaRow(tokenId: string): Promise<StoredMetaRow | null> {
  if (!isTokenId(tokenId)) return null;
  const raw = (await loadJson<Record<string, StoredMetaRow>>("tokens")) ?? {};
  return raw[tokenId] ?? null;
}

// Bound total registry size. Metadata can be registered provisionally for any
// 32-hex tokenId before the token is indexed, so without a cap an attacker could
// spam new tokenIds and grow the store unboundedly. Updates to existing tokens
// are always allowed; only NEW tokenIds are refused once the cap is hit.
export const MAX_TOKENS = 100_000;

/** Persist a token's sanitized meta together with its auth row. */
export async function saveMetaRow(tokenId: string, meta: LaunchMeta, auth: MetaAuthRow): Promise<void> {
  if (!isTokenId(tokenId)) throw new Error("invalid tokenId");
  const raw = (await loadJson<Record<string, StoredMetaRow>>("tokens")) ?? {};
  if (!(tokenId in raw) && Object.keys(raw).length >= MAX_TOKENS) {
    throw new Error("token registry full");
  }
  raw[tokenId] = { ...sanitizeMeta(meta), ...auth };
  await saveJson("tokens", raw);
}

/** @deprecated unauthenticated write — kept for tests/tools only. */
export async function registerToken(tokenId: string, meta: LaunchMeta): Promise<void> {
  await saveMetaRow(tokenId, meta, {});
}
