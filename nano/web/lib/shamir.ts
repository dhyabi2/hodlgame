// Shamir secret sharing over GF(256) — k-of-n splitting for custody seeds
// (roadmap W1 layer 0). Self-contained, zero dependencies, no runtime code
// imports this: it is used only by the offline CLI (scripts/shamir-split.ts).
//
// Standard construction: each secret byte becomes the constant term of a
// random degree-(k-1) polynomial over GF(2^8) (AES polynomial 0x11b); share i
// is the polynomial evaluated at x = i. Any k shares reconstruct via Lagrange
// interpolation at x = 0; k-1 shares reveal nothing (every candidate secret
// remains equally consistent).
//
// Share wire format: 2-hex share index (01..ff) ‖ hex payload (same length as
// the secret). Indexes matter — keep them with the share.

import { randomBytes } from "node:crypto";

// GF(256) arithmetic (AES field).
function gfMul(a: number, b: number): number {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11b;
    b >>= 1;
  }
  return p;
}
function gfPow(a: number, e: number): number {
  let r = 1;
  for (let i = 0; i < e; i++) r = gfMul(r, a);
  return r;
}
function gfInv(a: number): number {
  if (a === 0) throw new Error("division by zero in GF(256)");
  return gfPow(a, 254); // a^(2^8 - 2) = a^-1
}

export interface Share {
  index: number; // 1..255
  data: Uint8Array;
}

export function splitSecret(secret: Uint8Array, k: number, n: number): Share[] {
  if (!(k >= 2 && n >= k && n <= 255)) throw new Error("need 2 <= k <= n <= 255");
  // One random polynomial per secret byte: coeffs[b] = [secret[b], r1..r(k-1)].
  const coeffs: Uint8Array[] = [];
  for (let b = 0; b < secret.length; b++) {
    const c = new Uint8Array(k);
    c[0] = secret[b];
    c.set(randomBytes(k - 1), 1);
    coeffs.push(c);
  }
  const shares: Share[] = [];
  for (let x = 1; x <= n; x++) {
    const data = new Uint8Array(secret.length);
    for (let b = 0; b < secret.length; b++) {
      let y = 0;
      for (let j = 0; j < k; j++) y ^= gfMul(coeffs[b][j], gfPow(x, j));
      data[b] = y;
    }
    shares.push({ index: x, data });
  }
  return shares;
}

export function combineShares(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error("need at least 2 shares");
  const len = shares[0].data.length;
  const xs = shares.map((s) => s.index);
  if (new Set(xs).size !== xs.length) throw new Error("duplicate share indexes");
  if (shares.some((s) => s.data.length !== len)) throw new Error("share length mismatch");
  const secret = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let y0 = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis at x=0: Π_{j≠i} x_j / (x_j ⊕ x_i)   (subtraction = XOR)
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (j === i) continue;
        basis = gfMul(basis, gfMul(xs[j], gfInv(xs[j] ^ xs[i])));
      }
      y0 ^= gfMul(shares[i].data[b], basis);
    }
    secret[b] = y0;
  }
  return secret;
}

export function shareToString(s: Share): string {
  return s.index.toString(16).padStart(2, "0") + Buffer.from(s.data).toString("hex");
}

export function shareFromString(str: string): Share {
  const clean = str.trim().toLowerCase();
  if (!/^[0-9a-f]{4,}$/.test(clean) || clean.length % 2 !== 0) throw new Error("share must be hex");
  const index = parseInt(clean.slice(0, 2), 16);
  if (index < 1) throw new Error("bad share index");
  return { index, data: Uint8Array.from(Buffer.from(clean.slice(2), "hex")) };
}
