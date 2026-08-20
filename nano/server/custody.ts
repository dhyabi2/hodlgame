// Pool custody: derive the pool account, sign XNO payouts.
//
// v1 uses a single pool key (POOL_SEED). The sign() path already supports
// collecting extra cosignatures (2-of-3 multisig) — pass additional seeds and
// the payout block is submitted with a `signatures` array instead of a single
// signature.

import * as nanocurrency from "nanocurrency";
import { blake2bHex } from "blakejs";
import { keysFromSeed } from "../client/nano";
import { nanoRpc } from "../lib/rpc";

export interface PoolKeys {
  address: string;
  publicKey: string;
  secretKey: string;
}

export function poolKeysFromSeed(seed: string): PoolKeys {
  const k = keysFromSeed(seed);
  return { address: k.address, publicKey: k.publicKey, secretKey: k.secretKey };
}

/**
 * Deterministically derive a distinct pool key for a token from a master seed.
 * `poolSeedForToken(master, tokenId) = blake2b(master ‖ tokenId)` — so each
 * token's XNO pool is its own Nano account, recoverable from the master seed
 * alone (HD-style; no per-token secret storage).
 */
export function poolSeedForToken(masterSeed: string, tokenId: string): string {
  return blake2bHex(Buffer.from(masterSeed + tokenId, "hex"), undefined, 32);
}

export function tokenPoolKeys(masterSeed: string, tokenId: string): PoolKeys {
  return poolKeysFromSeed(poolSeedForToken(masterSeed, tokenId));
}

export interface Payout {
  to: string; // recipient nano_ address
  amountRaw: string; // XNO amount in raw
  frontier: string; // pool's current frontier
  balance: string; // pool's current balance
  representative: string;
}

/**
 * Sign a pool → recipient send block. Returns the block ready for `process`.
 * When `cosignerSeeds` are provided, the block carries a `signatures` array
 * (multisig) instead of a single `signature`.
 */
export async function signPayout(
  pool: PoolKeys,
  payout: Payout,
  rpcKey: string,
  cosignerSeeds: string[] = []
): Promise<any> {
  const newBalance = (BigInt(payout.balance) - BigInt(payout.amountRaw)).toString();

  const build = (work: string) => {
    const b = nanocurrency.createBlock(pool.secretKey, {
      work,
      previous: payout.frontier,
      representative: payout.representative,
      balance: newBalance,
      link: (nanocurrency as any).derivePublicKey(payout.to) || payout.to,
    });
    const blk: any = { ...b.block };
    blk.account = blk.account.replace(/^xrb_/, "nano_");
    blk.link = payout.to; // send: link = destination account address
    delete blk.link_as_account;
    return blk;
  };

  // Sign with the pool key, then collect cosignatures over the same hash.
  const hash = (nanocurrency as any).hashBlock({
    account: pool.address,
    previous: payout.frontier,
    representative: payout.representative,
    balance: newBalance,
    link: payout.to,
  });

  const poolSig = (nanocurrency as any).signBlock({ hash, secretKey: pool.secretKey });

  if (cosignerSeeds.length === 0) {
    const work = (await nanoRpc(rpcKey, { action: "work_generate", hash: payout.frontier, difficulty: "fffffff800000000" })).work;
    const blk = build(work);
    blk.signature = poolSig;
    return blk;
  }

  // Multisig: pool key + each cosigner sign the same block hash.
  const signatures = [poolSig];
  for (const seed of cosignerSeeds) {
    const c = keysFromSeed(seed);
    signatures.push((nanocurrency as any).signBlock({ hash, secretKey: c.secretKey }));
  }
  const work = (await nanoRpc(rpcKey, { action: "work_generate", hash: payout.frontier, difficulty: "fffffff800000000" })).work;
  const blk = build(work);
  delete blk.signature;
  blk.signatures = signatures;
  return blk;
}

/** Broadcast a payout block to rpc.nano.to. */
export async function broadcastPayout(rpcKey: string, block: any): Promise<string> {
  const r = await nanoRpc(rpcKey, { action: "process", json_block: "true", block });
  return r.hash as string;
}
