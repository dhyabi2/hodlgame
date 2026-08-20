// Off-chain token metadata registry. The compact launch op carries only the
// supply; name/symbol/decimals/image + socials are published off-chain (durable
// store) and fed back through the indexer's MetaResolver. Keyed by tokenId.

import type { LaunchMeta } from "../indexer/multiIndexer";
import { loadJson, saveJson } from "./store";
import { isTokenId, sanitizeMeta } from "./validate";

export const EMPTY_META: LaunchMeta = { name: "", symbol: "", decimals: 6, image: "" };

/** tokenId → metadata. Returns an empty map if no registry exists yet. */
export async function loadRegistry(): Promise<Map<string, LaunchMeta>> {
  const raw = (await loadJson<Record<string, LaunchMeta>>("tokens")) ?? {};
  const out = new Map<string, LaunchMeta>();
  // Sanitize on read too, so any pre-existing bad rows (e.g. decimals=-1, which
  // would crash analytics) can never take down the feed.
  for (const [id, meta] of Object.entries(raw)) {
    if (!isTokenId(id)) continue;
    out.set(id, sanitizeMeta(meta));
  }
  return out;
}

export async function registerToken(tokenId: string, meta: LaunchMeta): Promise<void> {
  if (!isTokenId(tokenId)) throw new Error("invalid tokenId");
  const reg = await loadRegistry();
  reg.set(tokenId, sanitizeMeta(meta));
  await saveJson("tokens", Object.fromEntries(reg));
}