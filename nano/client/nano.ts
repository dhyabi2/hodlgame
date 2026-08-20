// HoldFun Nano L2 — minimal Nano client (keys, block signing, verification).
//
// Uses the `nanocurrency` package, which implements Nano's Ed25519-blake2b
// (NOT standard Ed25519-SHA512 — the distinction BlackBird calls out). Do not
// swap it for a generic ed25519 lib.

import { randomBytes } from "node:crypto";
import * as nanocurrency from "nanocurrency";

export interface NanoKeys {
  seed: string;
  secretKey: string;
  publicKey: string;
  address: string;
}

export function generateKeys(): NanoKeys {
  const seed = randomBytes(32).toString("hex");
  return keysFromSeed(seed);
}

export function keysFromSeed(seed: string): NanoKeys {
  const secretKey = nanocurrency.deriveSecretKey(seed, 0);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  return { seed, secretKey, publicKey, address };
}

/** A data block: 0-value state block whose `link` carries the op commitment. */
export function signDataBlock(
  secretKey: string,
  {
    previous,
    representative,
    link,
    work = "0000000000000000",
  }: { previous: string; representative: string; link: string; work?: string }
) {
  return nanocurrency.createBlock(secretKey, {
    work,
    previous,
    representative,
    balance: "0",
    link,
  });
}

/** Verify a signed block's signature against the account public key. */
export function verifySignature(hash: string, signature: string, publicKey: string): boolean {
  // nanocurrency.verifyBlock({ hash, signature, publicKey }) does the real
  // blake2b+ed25519 check (checkSignature only validates string format).
  return (nanocurrency as any).verifyBlock({ hash, signature, publicKey });
}
