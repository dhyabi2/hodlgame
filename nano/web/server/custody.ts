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

/**
 * A guardian's own key. Unlike the pool key (HD-derived from the master seed),
 * each guardian key MUST be an independently generated seed held only on that
 * guardian's machine. The master seed cannot derive it, so no single party
 * holds a quorum of the 2-of-3 (operator key + guardian-1 key + guardian-2 key).
 */
export function guardianKeys(seed: string): PoolKeys {
  return poolKeysFromSeed(seed);
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

/** The block hash a pool → recipient send will have (what cosigners must sign). */
export function payoutBlockHash(pool: PoolKeys, payout: Payout): string {
  const newBalance = (BigInt(payout.balance) - BigInt(payout.amountRaw)).toString();
  return (nanocurrency as any).hashBlock({
    account: pool.address,
    previous: payout.frontier,
    representative: payout.representative,
    balance: newBalance,
    link: payout.to,
  });
}

/** Sign a block hash with a secret key (used by local cosigners and the guardian). */
export function cosignHash(secretKey: string, hash: string): string {
  return (nanocurrency as any).signBlock({ hash, secretKey });
}

/**
 * Sign a payout given externally-collected cosignatures (e.g. from a remote
 * guardian). Emits a block with a `signatures` array = [poolSig, ...cosignerSigs].
 */
export async function signPayoutWithSignatures(
  pool: PoolKeys,
  payout: Payout,
  rpcKey: string,
  cosignerSigs: string[]
): Promise<any> {
  const newBalance = (BigInt(payout.balance) - BigInt(payout.amountRaw)).toString();
  const hash = payoutBlockHash(pool, payout);
  const poolSig = cosignHash(pool.secretKey, hash);
  const work = (await nanoRpc(rpcKey, { action: "work_generate", hash: payout.frontier, difficulty: "fffffff800000000" })).work;

  const b = nanocurrency.createBlock(pool.secretKey, {
    work,
    previous: payout.frontier,
    representative: payout.representative,
    balance: newBalance,
    link: (nanocurrency as any).derivePublicKey(payout.to) || payout.to,
  });
  const blk: any = { ...b.block };
  blk.account = blk.account.replace(/^xrb_/, "nano_");
  blk.link = payout.to;
  delete blk.link_as_account;
  delete blk.signature;
  blk.signatures = [poolSig, ...cosignerSigs];
  return blk;
}

/** Ask a remote guardian to co-sign a payout. Returns null if unavailable. */
export async function remoteCosign(
  url: string,
  apiKey: string,
  args: { tokenId: string; pool: PoolKeys; payout: Payout }
): Promise<string | null> {
  try {
    const newBalance = (BigInt(args.payout.balance) - BigInt(args.payout.amountRaw)).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        tokenId: args.tokenId,
        account: args.pool.address,
        previous: args.payout.frontier,
        representative: args.payout.representative,
        balance: newBalance,
        link: args.payout.to,
      }),
    });
    const j = (await res.json()) as { signature?: string };
    return j.signature ?? null;
  } catch {
    return null;
  }
}
