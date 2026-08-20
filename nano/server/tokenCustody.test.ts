import { strict as assert } from "node:assert";
import { poolSeedForToken, tokenPoolKeys, cosignerSeeds, cosignerPoolKeys } from "./custody";

const MASTER = "f".repeat(64);
const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

// 1. Deterministic: same master+token → same key every time.
{
  const k1 = tokenPoolKeys(MASTER, TOKEN_A);
  const k2 = tokenPoolKeys(MASTER, TOKEN_A);
  assert.equal(k1.address, k2.address, "deterministic derivation");
  assert.equal(k1.secretKey, k2.secretKey);
}

// 2. Different tokens → different pool accounts.
{
  const a = tokenPoolKeys(MASTER, TOKEN_A);
  const b = tokenPoolKeys(MASTER, TOKEN_B);
  assert.notEqual(a.address, b.address, "per-token pool keys diverge");
  assert.notEqual(a.secretKey, b.secretKey);
}

// 3. Derived seed is a valid 32-byte hex and differs from the master.
{
  const seed = poolSeedForToken(MASTER, TOKEN_A);
  assert.equal(seed.length, 64, "sub-seed is 32 bytes");
  assert.notEqual(seed, MASTER, "sub-seed differs from master");
}

// 4. Secret key round-trips to the reported public key.
{
  const k = tokenPoolKeys(MASTER, TOKEN_A);
  assert.ok(k.address.startsWith("nano_"), "valid nano address");
  assert.equal(k.publicKey.length, 64, "public key is 32 bytes");
}

// 5. Cosigner shares are distinct, deterministic, and never equal the pool key.
{
  const seeds = cosignerSeeds(MASTER, TOKEN_A);
  assert.equal(seeds.length, 2, "two cosigner shares");
  const again = cosignerSeeds(MASTER, TOKEN_A);
  assert.deepEqual(seeds, again, "cosigner shares are deterministic");
  const pool = tokenPoolKeys(MASTER, TOKEN_A);
  const cos = cosignerPoolKeys(MASTER, TOKEN_A);
  const addrs = [pool.address, ...cos.map((c) => c.address)];
  assert.equal(new Set(addrs).size, 3, "pool + 2 cosigners are 3 distinct accounts");
  assert.notEqual(seeds[0], seeds[1], "shares differ");
  assert.equal(seeds[0].length, 64, "share is 32-byte hex");
}

console.log("✅ per-token custody derivation tests passed");