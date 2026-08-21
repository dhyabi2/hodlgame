// Orphan-image garbage collection. Uploaded images live in the durable store
// under `img:<id>` and are referenced by a token's metadata as
// `/api/image/<id>`. A launch that never completes, or a metadata update that
// swaps the image, leaves the old blob unreferenced forever. This sweep deletes
// image blobs that (a) no current metadata references and (b) are older than a
// grace period (so an in-flight upload/launch is never touched). Conservative:
// an image whose age can't be determined is kept.

import { loadRegistry } from "./tokens";
import { listImageIds, delImage } from "./store";

const IMG_REF = /\/api\/image\/([0-9a-f]{32})/;

export async function gcOrphanImages(opts: { graceMs?: number; dryRun?: boolean } = {}): Promise<{
  scanned: number;
  referenced: number;
  orphans: number;
  deleted: number;
}> {
  const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000; // 24h default
  const reg = await loadRegistry();
  const referenced = new Set<string>();
  for (const meta of reg.values()) {
    const m = String(meta.image ?? "").match(IMG_REF);
    if (m) referenced.add(m[1]);
  }
  const all = await listImageIds();
  let deleted = 0;
  for (const { id, ageMs } of all) {
    if (referenced.has(id)) continue;
    if (ageMs < 0 || ageMs < graceMs) continue; // unknown age or too recent → keep
    if (!opts.dryRun) await delImage(id);
    deleted++;
  }
  return { scanned: all.length, referenced: referenced.size, orphans: all.length - referenced.size, deleted };
}
