// Off-chain token metadata registry. The compact launch op carries only the
// supply; name/symbol/decimals/image are published off-chain (a JSON file) and
// fed back through the indexer's MetaResolver. Keyed by tokenId.

import * as fs from "node:fs";
import * as path from "node:path";
import type { LaunchMeta } from "../indexer/multiIndexer";

export const EMPTY_META: LaunchMeta = { name: "", symbol: "", decimals: 6, image: "" };

function registryFile(): string {
  return process.env.TOKENS_FILE ?? path.join(process.cwd(), ".tokens.json");
}

/** tokenId → metadata. Returns an empty map if no registry exists yet. */
export function loadRegistry(): Map<string, LaunchMeta> {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), "utf-8"));
    return new Map(Object.entries(raw).map(([k, v]) => [k, v as LaunchMeta]));
  } catch {
    return new Map();
  }
}

export function registerToken(tokenId: string, meta: LaunchMeta): void {
  const reg = loadRegistry();
  reg.set(tokenId, meta);
  fs.writeFileSync(registryFile(), JSON.stringify(Object.fromEntries(reg), null, 2));
}

/** MetaResolver bound to the on-disk registry. */
export function registryMetaResolver() {
  const reg = loadRegistry();
  return (tokenId: string): LaunchMeta => reg.get(tokenId) ?? EMPTY_META;
}