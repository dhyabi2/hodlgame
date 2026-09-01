import { NextResponse } from "next/server";
import { cacheInfo } from "../../server/market";

/** Attach cache provenance to a response. Makes "is this cached, how old, keyed
 * on what" a header read instead of an investigation — the whole point of
 * keeping a cache debuggable. */
export function withCacheHeaders(res: NextResponse): NextResponse {
  const c = cacheInfo();
  res.headers.set("x-cache", c.hit ? "hit" : "miss");
  res.headers.set("x-cache-key", c.key ? c.key.slice(0, 16) : "-");
  res.headers.set("x-cache-age-ms", String(c.ageMs));
  res.headers.set("x-computed-at", c.computedAt ? new Date(c.computedAt).toISOString() : "-");
  res.headers.set("x-accounts", String(c.accounts));
  return res;
}

/** `?fresh=1` on any data route = full bypass (no cache read, no write). */
export function wantsFresh(req: Request): boolean {
  try { return new URL(req.url).searchParams.get("fresh") === "1"; } catch { return false; }
}
