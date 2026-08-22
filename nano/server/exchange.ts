// Exchange Integration Kit (docs/EXCHANGE-KIT.md). Everything an exchange
// needs to list a HoldFun token, given that token balances live in the
// off-chain deterministic ledger (they verify the state root rather than
// trust it). Pure/read helpers here; the withdrawal signer is a library the
// exchange runs with ITS OWN key (client/exchangeWithdraw.ts) — we never hold
// the exchange's keys.

import { blake2bHex } from "blakejs";
import * as nanocurrency from "nanocurrency";
import { raw } from "./market";
import { stateRoot } from "../core/canonical";
import { balanceRoot, proveBalance, type MerkleProof } from "../core/merkle";

/**
 * Deterministic per-customer deposit account, HD-derived from the exchange's
 * own master seed: seed = blake2b(master ‖ "holdfun-deposit" ‖ customerId).
 * The exchange watches these accounts; a token transfer to one credits that
 * customer. Derivation is the exchange's alone — HoldFun never sees the seed.
 */
export function depositSeed(masterSeed: string, customerId: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(masterSeed)) throw new Error("master seed must be 64 hex");
  const payload = Buffer.concat([
    Buffer.from(masterSeed, "hex"),
    Buffer.from("holdfun-deposit\0", "utf8"),
    Buffer.from(customerId, "utf8"),
  ]);
  return blake2bHex(payload, undefined, 32);
}

export function depositAddress(masterSeed: string, customerId: string): string {
  const sk = nanocurrency.deriveSecretKey(depositSeed(masterSeed, customerId), 0);
  return nanocurrency.deriveAddress(nanocurrency.derivePublicKey(sk), { useNanoPrefix: true });
}

export interface TokenInfo {
  tokenId: string;
  symbol: string;
  name: string;
  decimals: number; // consensus-bound in the launch op link — safe to pin
  supply: string;
  creator: string;
  metadataAuthority: string | null;
  metadataImmutable: boolean;
  priceRaw: string;
  poolAddress: string | null;
}

/** Everything an exchange pins to list a token. `decimals` comes from the
 * launch op link (consensus), NOT the mutable registry — see oplink.ts. */
export async function tokenInfo(tokenId: string): Promise<TokenInfo | null> {
  const m = await raw();
  const s = m.state.get(tokenId);
  if (!s) return null;
  const authority = m.metaAuthority.get(tokenId);
  const pub = m.idx.getChainPools().get(tokenId);
  const analytics = m.byToken.get(tokenId);
  return {
    tokenId,
    symbol: s.symbol,
    name: s.name,
    decimals: s.decimals, // from the launch link (consensus); verify via the
    // launch block's link byte 1 (decimals+1) — see docs/EXCHANGE-KIT.md.
    supply: s.supply.toString(),
    creator: s.creator,
    metadataAuthority: authority?.authority ?? s.creator ?? null,
    metadataImmutable: Boolean(authority?.immutable),
    priceRaw: analytics?.priceRaw ?? "0",
    poolAddress: pub ? nanocurrency.deriveAddress(pub, { useNanoPrefix: true }) : null,
  };
}

export interface BalanceInfo {
  tokenId: string;
  account: string;
  balanceRaw: string;
  decimals: number;
  stateRoot: string; // pin this + verify.ts to prove the balance from chain
}

/** A customer's token balance plus the state root that authenticates it.
 * The exchange verifies the root with scripts/verify.ts (zero secrets) and
 * trusts the balance because it is the replay, not a claim. */
export async function tokenBalance(tokenId: string, account: string): Promise<BalanceInfo> {
  const m = await raw();
  const s = m.state.get(tokenId);
  return {
    tokenId,
    account,
    balanceRaw: (s?.balances.get(account) ?? 0n).toString(),
    decimals: s?.decimals ?? 6,
    stateRoot: stateRoot(m.state),
  };
}

export interface BalanceProofInfo {
  tokenId: string;
  account: string;
  balanceRaw: string;
  balanceRoot: string; // Merkle root over all holdings — establish once, reuse
  proof: MerkleProof | null; // null if the account holds none of this token
  stateRoot: string;
}

/** A Merkle inclusion proof of one holding against the balance root. Lets a
 * light exchange verify this balance in O(log N) with core/merkle
 * verifyMerkleProof — no full replay — after it has established the balance
 * root once by RECOMPUTING it from its own periodic replay. The balance root
 * has NO on-chain anchor and is not committed by the state root, so an exchange
 * must never accept a server-supplied root at face value (see core/merkle.ts
 * trust model). */
export async function balanceProof(tokenId: string, account: string): Promise<BalanceProofInfo> {
  const m = await raw();
  const s = m.state.get(tokenId);
  return {
    tokenId,
    account,
    balanceRaw: (s?.balances.get(account) ?? 0n).toString(),
    balanceRoot: balanceRoot(m.state),
    proof: proveBalance(m.state, tokenId, account),
    stateRoot: stateRoot(m.state),
  };
}
