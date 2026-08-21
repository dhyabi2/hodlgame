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

/** Cap a free-text field and coerce to string. */
export function clampText(v: unknown, max: number): string {
  return String(v ?? "").slice(0, max);
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

/** Sanitize a full token-metadata payload from an untrusted request. */
export function sanitizeMeta(body: any) {
  return {
    name: clampText(body?.name, 64),
    symbol: clampText(body?.symbol, 16),
    decimals: clampDecimals(body?.decimals ?? 6),
    image: safeUrl(body?.image),
    description: clampText(body?.description, 1000),
    website: safeUrl(body?.website),
    twitter: safeUrl(body?.twitter),
    telegram: safeUrl(body?.telegram),
  };
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
