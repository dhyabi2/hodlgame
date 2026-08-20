// Off-chain token metadata registry. The compact launch op carries only the
// supply; name/symbol/decimals/image + socials are published off-chain (durable
// store) and fed back through the indexer's MetaResolver. Keyed by tokenId.

import type { LaunchMeta } from "../indexer/multiIndexer";
import { loadJson, saveJson } from "./store";

export const EMPTY_META: LaunchMeta = { name: "", symbol: "", decimals: 6, image: "" };

/** tokenId → metadata. Returns an empty map if no registry exists yet. */
export function loadRegistry(): Map<string, LaunchMeta> {
  const raw = loadJson<Record<string, LaunchMeta>>("tokens.json") ?? {};
  return new Map(Object.entries(raw));
}

export function registerToken(tokenId: string, meta: LaunchMeta): void {
  const reg = loadRegistry();
  reg.set(tokenId, meta);
  saveJson("tokens.json", Object.fromEntries(reg));
}

/** MetaResolver bound to the on-disk registry. */
export function registryMetaResolver() {
  const reg = loadRegistry();
  return (tokenId: string): LaunchMeta => reg.get(tokenId) ?? EMPTY_META;
}