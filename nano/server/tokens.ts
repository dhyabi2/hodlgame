// Off-chain token metadata registry. The compact launch op carries only the
// supply; name/symbol/decimals/image + socials are published off-chain (durable
// store) and fed back through the indexer's MetaResolver. Keyed by tokenId.

import type { LaunchMeta } from "../indexer/multiIndexer";
import { loadJson, saveJson } from "./store";

export const EMPTY_META: LaunchMeta = { name: "", symbol: "", decimals: 6, image: "" };

/** tokenId → metadata. Returns an empty map if no registry exists yet. */
export async function loadRegistry(): Promise<Map<string, LaunchMeta>> {
  const raw = (await loadJson<Record<string, LaunchMeta>>("tokens")) ?? {};
  return new Map(Object.entries(raw));
}

export async function registerToken(tokenId: string, meta: LaunchMeta): Promise<void> {
  const reg = await loadRegistry();
  reg.set(tokenId, meta);
  await saveJson("tokens", Object.fromEntries(reg));
}