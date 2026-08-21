// Shared in-memory rate limiter + client-IP extraction for the HTTP surface.
// Per-process (each serverless instance has its own window) — a coarse but
// effective backstop against spam/DoS on the write endpoints, layered under the
// signature gates. Not a substitute for a global limiter, just a cheap first cut.

const hits = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now > e.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    // opportunistic cleanup so the map can't grow unbounded
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    return true;
  }
  if (e.n >= max) return false;
  e.n++;
  return true;
}

/** The true client IP. x-forwarded-for is client-controllable, so trust
 * x-real-ip (set by the platform) and otherwise the LAST x-forwarded-for hop. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return req.headers.get("x-real-ip")?.trim() || (xff && xff.length ? xff[xff.length - 1] : "shared");
}
