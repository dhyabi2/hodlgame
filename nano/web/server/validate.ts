// Shared input validation / sanitization for the HTTP surface.
//
// Everything here defends the off-chain registries (token metadata, comments,
// commit-reveal ops) that are written by UNAUTHENTICATED callers and later fed
// back through the deterministic indexer / analytics. The on-chain ledger is
// self-defending (signatures + replay), but these off-chain inputs are not, so
// they are clamped to safe shapes here.

export const MAX_DECIMALS = 18;
export const MIN_DECIMALS = 0;

/** 32-hex tokenId (128-bit launch-hash prefix). */
export function isTokenId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-fA-F]{32}$/.test(v);
}

/** nano_/xrb_ account address (60-char base32 body). */
export function isNanoAddress(v: unknown): v is string {
  return typeof v === "string" && /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(v);
}

/** Clamp decimals into the sane 0..18 range — `10n ** BigInt(decimals)` is used
 * in analytics, so a negative value throws (RangeError) and a huge value builds
 * a multi-gigabyte BigInt: either one, from one token, would take down the whole
 * market feed. */
export function clampDecimals(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 6;
  if (n < MIN_DECIMALS) return MIN_DECIMALS;
  if (n > MAX_DECIMALS) return MAX_DECIMALS;
  return n;
}

/** Cap a free-text field and coerce to string (code-point safe — never splits a
 * surrogate pair). Kept for callers that want a raw cap; prefer sanitizeInline
 * for anything user-facing. */
export function clampText(v: unknown, max: number): string {
  const s = String(v ?? "");
  const cp = Array.from(s);
  return cp.length > max ? cp.slice(0, max).join("") : s;
}

// Characters that enable spoofing / rendering attacks in short display fields:
// zero-width joiners/spaces, bidi overrides (U+202A–202E, U+2066–2069) that can
// reverse/reorder text to impersonate another token, and the BOM.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
// C0 + C1 control characters (null bytes, escape, etc.).
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const CONTROL_KEEP_WS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g; // keep \t \n \r

/**
 * Normalize + defang a user-facing text field. Unicode-normalizes (NFC),
 * strips invisible/bidi-override characters and control bytes, collapses
 * runs of whitespace, trims, and caps by code points (not UTF-16 units, so a
 * multi-byte glyph is never cut in half). Deterministic and browser-safe so the
 * client can sign exactly what the server will store.
 */
export function sanitizeInline(v: unknown, max: number, multiline = false): string {
  let s = String(v ?? "");
  try { s = s.normalize("NFC"); } catch { /* invalid input; leave as-is */ }
  s = s.replace(INVISIBLE, "").replace(multiline ? CONTROL_KEEP_WS : CONTROL, "");
  s = multiline ? s.replace(/[ \t]+/g, " ").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  s = s.trim();
  const cp = Array.from(s);
  return cp.length > max ? cp.slice(0, max).join("") : s;
}

/**
 * Ticker symbol: restricted to ASCII [A-Za-z0-9._-] so it can't homograph-spoof
 * an established token with look-alike Unicode. Empty result is allowed here and
 * rejected by the route (kept pure so both client + server agree byte-for-byte).
 */
export function sanitizeSymbol(v: unknown): string {
  return String(v ?? "").normalize("NFC").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
}

/** Site-relative uploaded-image path (`/api/image/<32hex>`), the form the
 * upload route returns. Relative keeps it portable across domains/aliases and
 * valid on plain-http local dev, where an absolute http: URL would be dropped. */
const UPLOADED_IMAGE = /^\/api\/image\/[0-9a-f]{32}$/;

/** Image URL: like safeUrl but rejects cleartext http: (mixed-content / tracking
 * beacon) — only https:, ipfs:, or our own /api/image/<id> may be an <img src>. */
export function safeImageUrl(v: unknown, max = 512): string {
  const s = String(v ?? "").trim();
  if (UPLOADED_IMAGE.test(s)) return s;
  const u = safeUrl(s, max);
  if (!u) return "";
  return u.startsWith("http://") ? "" : u;
}

/**
 * Allow only http(s) (and ipfs:) URLs for anything rendered as a link or image
 * src. Rejects `javascript:`, `data:`, `vbscript:`, etc. — a token's website /
 * twitter / telegram is rendered as `<a href>`, so an unfiltered `javascript:`
 * URL is stored XSS. Returns "" if the URL is not a safe absolute http(s) URL.
 */
export function safeUrl(v: unknown, max = 512): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length > max) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ipfs:") return "";
  // Strip embedded credentials (https://user:pass@host) — a phishing/UI aid
  // with no legitimate use for an image/social link.
  u.username = "";
  u.password = "";
  return u.toString();
}

/** Sanitize a full token-metadata payload from an untrusted request. Shared by
 * the client (which signs exactly this) and the server (which verifies + stores
 * exactly this), so both agree byte-for-byte. */
export function sanitizeMeta(body: any) {
  return {
    name: sanitizeInline(body?.name, 48),
    symbol: sanitizeSymbol(body?.symbol),
    decimals: clampDecimals(body?.decimals ?? 6),
    image: safeImageUrl(body?.image),
    description: sanitizeInline(body?.description, 600, true),
    website: safeUrl(body?.website),
    twitter: safeUrl(body?.twitter),
    telegram: safeUrl(body?.telegram),
  };
}

/** True when the sanitized metadata has the minimum required fields — a non-empty
 * name and symbol. Route rejects anything that fails this. */
export function metaHasRequired(meta: { name: string; symbol: string; image?: string }): boolean {
  // name, symbol AND image are required — sanitizeMeta has already blanked any
  // unsafe image URL, so a non-empty image here is a valid https/ipfs link.
  return meta.name.trim().length > 0 && meta.symbol.length > 0 && (meta.image ?? "").length > 0;
}

// Amount bounds for off-chain commit-reveal ops. Amounts are bigint; a negative
// value would flip conservation checks (e.g. `tokens > treasury` is false for a
// negative), and an absurdly large one is meaningless. Bound to a 120-bit range
// (comfortably above any real supply, below the 15-byte op-link ceiling).
export const MAX_AMOUNT = (1n << 120n) - 1n;

export function isSaneAmount(v: unknown): boolean {
  return typeof v === "bigint" && v >= 0n && v <= MAX_AMOUNT;
}

/** Validate a commit-reveal op's shape + amount bounds. Returns null if bad. */
export function validateCommitOp(op: any): { ok: true } | { ok: false; reason: string } {
  if (!op || typeof op !== "object" || typeof op.kind !== "string") {
    return { ok: false, reason: "op.kind required" };
  }
  const amt = (k: string) => isSaneAmount(op[k]);
  switch (op.kind) {
    case "transfer":
      if (!isNanoAddress(op.to)) return { ok: false, reason: "transfer.to must be a nano address" };
      if (!amt("amount")) return { ok: false, reason: "transfer.amount out of range" };
      return { ok: true };
    case "seedLiq":
    case "addLiq":
      if (!amt("xno") || !amt("tokens")) return { ok: false, reason: `${op.kind} amounts out of range` };
      return { ok: true };
    case "buy":
      if (!amt("xno") || !amt("minTokens")) return { ok: false, reason: "buy amounts out of range" };
      return { ok: true };
    case "sell":
      if (!amt("tokens") || !amt("minXno")) return { ok: false, reason: "sell amounts out of range" };
      return { ok: true };
    default:
      return { ok: false, reason: "op.kind not allowed via commit-reveal" };
  }
}
