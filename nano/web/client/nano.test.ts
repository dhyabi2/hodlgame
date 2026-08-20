import { strict as assert } from "node:assert";
import { generateKeys, keysFromSeed, signDataBlock, verifySignature } from "./nano";
import { opCommitment } from "../core/encoding";

// 1. Key derivation is deterministic and addresses are well-formed.
{
  const a = keysFromSeed("0".repeat(64));
  const b = keysFromSeed("0".repeat(64));
  assert.equal(a.publicKey, b.publicKey, "same seed -> same pubkey");
  assert.equal(a.address, b.address, "same seed -> same address");
  assert.match(a.address, /^nano_[13][0-9a-z]{59}$/, "valid nano_ address");
}

// 2. Data block signs and the signature verifies.
{
  const k = generateKeys();
  const link = opCommitment({ kind: "claim" });
  const signed = signDataBlock(k.secretKey, {
    previous: "0".repeat(64),
    representative: k.address,
    link,
  });
  assert.equal(signed.block.link, link, "link carried into block");
  assert.equal(verifySignature(signed.hash, signed.block.signature, k.publicKey), true, "signature verifies");
  assert.equal(verifySignature(signed.hash, signed.block.signature, generateKeys().publicKey), false, "wrong key rejected");
}

console.log("✅ nano client tests passed");
