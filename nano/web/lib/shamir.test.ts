import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { splitSecret, combineShares, shareToString, shareFromString } from "./shamir";

// 1. Every k-subset reconstructs; k=2, n=3 over a real 32-byte seed.
{
  const secret = Uint8Array.from(randomBytes(32));
  const shares = splitSecret(secret, 2, 3);
  assert.equal(shares.length, 3);
  const pairs = [
    [shares[0], shares[1]],
    [shares[0], shares[2]],
    [shares[1], shares[2]],
  ];
  for (const pair of pairs) {
    assert.deepEqual(Buffer.from(combineShares(pair)), Buffer.from(secret), "any 2 of 3 reconstruct");
  }
  assert.deepEqual(Buffer.from(combineShares(shares)), Buffer.from(secret), "all 3 also reconstruct");
}

// 2. 3-of-5 too (the cold-treasury shape).
{
  const secret = Uint8Array.from(randomBytes(32));
  const shares = splitSecret(secret, 3, 5);
  assert.deepEqual(Buffer.from(combineShares([shares[4], shares[1], shares[3]])), Buffer.from(secret));
  // Fewer than k shares must NOT reconstruct the secret.
  const wrong = combineShares([shares[0], shares[1]]);
  assert.notDeepEqual(Buffer.from(wrong), Buffer.from(secret), "k-1 shares don't yield the secret");
}

// 3. A single share is not the secret (trivially) and no share equals it.
{
  const secret = Uint8Array.from(randomBytes(32));
  for (const s of splitSecret(secret, 2, 3)) {
    assert.notDeepEqual(Buffer.from(s.data), Buffer.from(secret), "shares never leak the secret verbatim");
  }
}

// 4. Wire format round-trips; malformed inputs rejected.
{
  const secret = Uint8Array.from(randomBytes(32));
  const [s] = splitSecret(secret, 2, 2);
  const str = shareToString(s);
  const back = shareFromString(str);
  assert.equal(back.index, s.index);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(s.data));
  assert.throws(() => shareFromString("zz11"), /hex/);
  assert.throws(() => shareFromString("00abcd"), /index/);
  assert.throws(() => combineShares([s, s]), /duplicate/);
}

// 5. Tampered share yields a WRONG secret (garbage in, detectably-different out).
{
  const secret = Uint8Array.from(randomBytes(32));
  const shares = splitSecret(secret, 2, 3);
  const tampered = { index: shares[1].index, data: Uint8Array.from(shares[1].data) };
  tampered.data[0] ^= 0xff;
  assert.notDeepEqual(
    Buffer.from(combineShares([shares[0], tampered])),
    Buffer.from(secret),
    "tampered share cannot silently reconstruct the real secret"
  );
}

console.log("✅ shamir secret-sharing tests passed");
