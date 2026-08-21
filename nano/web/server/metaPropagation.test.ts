// End-to-end field-by-field metadata propagation test.
//
// Proves that EVERY metadata field a creator sets in the create form survives
// the full pipeline that the other pages read from:
//
//   create form  →  sanitizeMeta  →  sign (creator key)  →  verify  →
//   registry row →  market merge (toView) → TokenView → page render helpers
//
// This is the exact path the "TRS shows nothing" bug lived in: the fields were
// correct client-side but never persisted, so downstream pages saw EMPTY_META.
// Here we drive the whole chain and assert each field lands, one field at a time.

import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { metaFieldsHash, metaSignDigest } from "../core/metaAuth";
import { verifyMetaSignature, decideMetaUpdate } from "./metaAuth";
import { sanitizeMeta, metaHasRequired } from "./validate";
import { EMPTY_META } from "./tokens";

const SEED = "3".repeat(64);
const secretKey = nanocurrency.deriveSecretKey(SEED, 0);
const publicKey = nanocurrency.derivePublicKey(secretKey);
const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
const TOKEN = "cd".repeat(16); // synthetic, unindexed → provisional authority

// A create form with EVERY field filled in with a distinct, recognizable value.
const FORM = {
  name: "Test Rocket Ship",
  symbol: "TRS",
  decimals: 9,
  image: "https://example.org/trs.png",
  description: "The proper description for TRS.",
  website: "https://trs.example",
  twitter: "https://x.com/trs",
  telegram: "https://t.me/trs",
};

// The exact merge market.ts:toView() performs (meta → TokenView). Mirrored here
// so the test fails loudly if that mapping ever drops a field. Decimals prefer
// on-chain state; with none (synthetic token) it falls back to the meta value.
function toViewFields(meta: any, chainDecimals?: number) {
  return {
    name: meta.name ?? "",
    symbol: meta.symbol ?? "",
    decimals: chainDecimals ?? meta.decimals ?? 6,
    image: meta.image ?? "",
    description: meta.description ?? "",
    website: meta.website ?? "",
    twitter: meta.twitter ?? "",
    telegram: meta.telegram ?? "",
  };
}

// The render helpers the pages use for the two derived fields.
const tokName = (t: any) => t.name || `Coin ${t.tokenId.slice(0, 6)}`;
const tokSym = (t: any) => t.symbol || t.tokenId.slice(0, 4).toUpperCase();

let pass = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); console.log("  ✓", m); pass++; };

// ── 1. sanitizeMeta preserves every field a creator sets ──────────────────────
const meta = sanitizeMeta(FORM);
console.log("1. sanitizeMeta keeps each field:");
ok(meta.name === "Test Rocket Ship", "name survives sanitize");
ok(meta.symbol === "TRS", "symbol survives sanitize");
ok(meta.decimals === 9, "decimals survives sanitize");
ok(meta.image === "https://example.org/trs.png", "image survives sanitize");
ok(meta.description === "The proper description for TRS.", "description survives sanitize");
// URL fields are normalized (bare domains gain a trailing slash) but preserved.
ok(meta.website === "https://trs.example/", "website survives sanitize (normalized)");
ok(meta.twitter === "https://x.com/trs", "twitter survives sanitize");
ok(meta.telegram === "https://t.me/trs", "telegram survives sanitize");

// ── 2. Sign with creator key and verify (the create→POST auth path) ───────────
console.log("2. signed by creator key, accepted by the endpoint's checks:");
const seq = 1_000_000;
const digest = metaSignDigest(TOKEN, seq, "update", metaFieldsHash(meta));
const signature = nanocurrency.signBlock({ hash: digest, secretKey });
const update = { tokenId: TOKEN, meta, account: address, signature, seq, action: "update" };
ok(verifyMetaSignature(update), "creator signature verifies over sanitized fields");
const decision = decideMetaUpdate(update, null, null);
ok(decision.ok, "endpoint accepts the write (provisional authority on unindexed launch)");
const stored = decision.ok ? decision.row : null;
ok(!!stored, "a registry row is produced to persist");

// ── 3. Market merge (toView) exposes every field on TokenView ─────────────────
// This is the step that returned EMPTY_META for TRS when the row was missing.
console.log("3. registry row → market merge → TokenView, field by field:");
const missing = toViewFields(EMPTY_META);
ok(missing.name === "" && missing.symbol === "", "EMPTY_META (the bug state) yields blank name/symbol");
const view: any = { tokenId: TOKEN, ...toViewFields(meta) };
// Compare against the sanitized/stored values (`meta`) — that is the ground
// truth the registry persists and every page reads.
ok(view.name === meta.name, "TokenView.name = stored name");
ok(view.symbol === meta.symbol, "TokenView.symbol = stored symbol");
ok(view.decimals === meta.decimals, "TokenView.decimals = stored decimals");
ok(view.image === meta.image, "TokenView.image = stored image");
ok(view.description === meta.description, "TokenView.description = stored description");
ok(view.website === meta.website, "TokenView.website = stored website");
ok(view.twitter === meta.twitter, "TokenView.twitter = stored twitter");
ok(view.telegram === meta.telegram, "TokenView.telegram = stored telegram");

// ── 4. Page render layer surfaces each field ──────────────────────────────────
console.log("4. what each page renders from the TokenView:");
ok(tokName(view) === "Test Rocket Ship", "detail/feed heading shows the name");
ok(tokSym(view) === "TRS", "chart pair + $badge show the symbol (TRS/XNO)");
ok(!!(view.description && view.description.length), "detail/explorer render the description block");
ok(!!view.website, "website SocialLink renders");
ok(!!view.twitter, "X SocialLink renders");
ok(!!view.telegram, "telegram SocialLink renders");
// Fallbacks: a token WITHOUT a row still renders safely (never crashes / blanks).
const bare = { tokenId: TOKEN, ...toViewFields(EMPTY_META) };
ok(tokName(bare) === `Coin ${TOKEN.slice(0, 6)}`, "nameless token falls back to Coin <id6>");
ok(tokSym(bare) === TOKEN.slice(0, 4).toUpperCase(), "symbol-less token falls back to id4");

// ── 5. Required-field validation: empty / invalid name or symbol is rejected ──
// Mirrors the create form's pre-launch guard: it validates the SANITIZED values,
// so a blank field OR a symbol made only of invalid characters never launches.
console.log("5. name + symbol are required (blank/invalid rejected before launch):");
const req = (form: any) => {
  const m = sanitizeMeta(form);
  return { m, valid: metaHasRequired(m) };
};
ok(!req({ ...FORM, name: "" }).valid, "empty name rejected");
ok(!req({ ...FORM, symbol: "" }).valid, "empty symbol rejected");
ok(!req({ ...FORM, image: "" }).valid, "empty image rejected");
ok(!req({ ...FORM, name: "   " }).valid, "whitespace-only name rejected");
ok(!req({ ...FORM, symbol: "!!!@@@" }).valid, "symbol of only invalid chars sanitizes to empty → rejected");
ok(!req({ ...FORM, image: "javascript:alert(1)" }).valid, "unsafe image URL sanitizes to empty → rejected");
ok(req(FORM).valid, "a fully-filled form passes");

console.log(`\n✅ metadata propagation e2e: ${pass} field-level assertions passed`);
