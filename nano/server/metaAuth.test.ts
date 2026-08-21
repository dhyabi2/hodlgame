import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { metaFieldsHash, metaSignDigest, type MetaFields } from "../core/metaAuth";
import { verifyMetaSignature, decideMetaUpdate, type SignedMetaUpdate } from "./metaAuth";

const SEED_A = "1".repeat(64);
const SEED_B = "2".repeat(64);
function keysFrom(seed: string) {
  const secretKey = nanocurrency.deriveSecretKey(seed, 0);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  return { secretKey, publicKey, address };
}
const CREATOR = keysFrom(SEED_A);
const ATTACKER = keysFrom(SEED_B);

const TOKEN = "ab".repeat(16);
const META: MetaFields = { name: "Doge", symbol: "DOGE", decimals: 6, image: "https://x/i.png", description: "wow" };

function signed(keys: typeof CREATOR, seq: number, action = "update", meta: MetaFields = META): SignedMetaUpdate {
  const digest = metaSignDigest(TOKEN, seq, action, metaFieldsHash(meta));
  const signature = nanocurrency.signBlock({ hash: digest, secretKey: keys.secretKey });
  return { tokenId: TOKEN, meta, account: keys.address, signature, seq, action };
}

// 1. Canonical hash is field-order sensitive (no concat ambiguity).
{
  const a = metaFieldsHash({ ...META, description: "x", website: "" });
  const b = metaFieldsHash({ ...META, description: "", website: "x" });
  assert.notEqual(a, b, "field boundaries are unambiguous");
  assert.match(metaSignDigest(TOKEN, 1, "update", a), /^[0-9A-F]{64}$/, "digest is 64-hex");
}

// 2. Signature roundtrip: creator verifies, attacker/tamper fails.
{
  const u = signed(CREATOR, 100);
  assert.ok(verifyMetaSignature(u), "creator signature verifies");
  assert.ok(!verifyMetaSignature({ ...u, account: ATTACKER.address }), "wrong account fails");
  assert.ok(!verifyMetaSignature({ ...u, meta: { ...META, name: "Evil" } }), "tampered meta fails");
  assert.ok(!verifyMetaSignature({ ...u, seq: 101 }), "tampered seq fails");
  assert.ok(!verifyMetaSignature({ ...u, action: "makeImmutable" }), "tampered action fails");
  assert.ok(!verifyMetaSignature({ ...u, signature: "0".repeat(128) }), "garbage signature fails");
}

// 3. Policy: unknown token → provisional first write; creator overrides it.
{
  const spoof = signed(ATTACKER, 50);
  const d1 = decideMetaUpdate(spoof, null, null);
  assert.ok(d1.ok, "provisional first write accepted while launch unindexed");
  assert.equal(d1.ok && d1.row.authority, ATTACKER.address);
  assert.equal(d1.ok && d1.row.authorityLocked, false, "provisional authority not locked");

  // Chain catches up: creator is known → attacker's row is overridden.
  const real = signed(CREATOR, 60);
  const d2 = decideMetaUpdate(real, d1.ok ? d1.row : null, CREATOR.address);
  assert.ok(d2.ok, "on-chain creator overrides provisional authority");
  assert.equal(d2.ok && d2.row.authorityLocked, true, "creator write locks authority");

  // Attacker can no longer write, even if the creator lookup fails later.
  const spoof2 = signed(ATTACKER, 70);
  const d3 = decideMetaUpdate(spoof2, d2.ok ? d2.row : null, null);
  assert.ok(!d3.ok && d3.code === 403, "locked authority rejects non-authority");
}

// 4. Policy: creator known from the start → attacker rejected outright.
{
  const spoof = signed(ATTACKER, 50);
  const d = decideMetaUpdate(spoof, null, CREATOR.address);
  assert.ok(!d.ok && d.code === 403, "attacker rejected when creator known");
}

// 5. Replay: seq must strictly increase.
{
  const u1 = signed(CREATOR, 100);
  const d1 = decideMetaUpdate(u1, null, CREATOR.address);
  assert.ok(d1.ok);
  const replay = decideMetaUpdate(u1, d1.ok ? d1.row : null, CREATOR.address);
  assert.ok(!replay.ok && replay.code === 409, "same seq rejected (replay)");
}

// 6. makeImmutable is one-way.
{
  const freeze = signed(CREATOR, 10, "makeImmutable");
  const d1 = decideMetaUpdate(freeze, null, CREATOR.address);
  assert.ok(d1.ok && d1.row.immutable, "makeImmutable sets flag");
  const later = signed(CREATOR, 20);
  const d2 = decideMetaUpdate(later, d1.ok ? d1.row : null, CREATOR.address);
  assert.ok(!d2.ok && d2.code === 403, "immutable metadata rejects even the creator");
}

// 7. setAuthority hands control over and stays locked.
{
  const handover = signed(CREATOR, 10, `setAuthority:${ATTACKER.address}`);
  const d1 = decideMetaUpdate(handover, null, CREATOR.address);
  assert.ok(d1.ok && d1.row.authority === ATTACKER.address && d1.row.authorityLocked, "authority transferred + locked");
  const newOwner = signed(ATTACKER, 20);
  const d2 = decideMetaUpdate(newOwner, d1.ok ? d1.row : null, CREATOR.address);
  assert.ok(d2.ok, "new authority can write even though creator differs");
  const old = signed(CREATOR, 30);
  const d3 = decideMetaUpdate(old, d1.ok ? d1.row : null, CREATOR.address);
  assert.ok(!d3.ok && d3.code === 403, "old creator locked out after transfer");
}

// 8. Bad actions rejected.
{
  const bad = signed(CREATOR, 10, "setAuthority:not_an_address");
  const d = decideMetaUpdate(bad, null, CREATOR.address);
  assert.ok(!d.ok && d.code === 400, "invalid setAuthority target rejected");
  const unknown = signed(CREATOR, 11, "selfdestruct");
  const d2 = decideMetaUpdate(unknown, null, CREATOR.address);
  assert.ok(!d2.ok && d2.code === 400, "unknown action rejected");
}

console.log("✅ metadata auth tests passed");
