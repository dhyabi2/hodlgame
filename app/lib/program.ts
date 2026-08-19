import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "./idl.json";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? (idl as any).metadata.address
);

export function getProvider(
  connection: Connection,
  wallet: WalletContextState
): AnchorProvider {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  return new AnchorProvider(
    connection,
    wallet as any,
    AnchorProvider.defaultOptions()
  );
}

export function getProgram(provider: AnchorProvider) {
  return new Program<any>(idl as any, PROGRAM_ID, provider);
}

export function findVaultStatePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function findStakeVaultPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_vault"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function findStakeAccountPDA(
  vaultState: PublicKey,
  user: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_account"), vaultState.toBuffer(), user.toBuffer()],
    PROGRAM_ID
  );
}

export function findVaultTokenAccount(
  mint: PublicKey,
  vaultState: PublicKey
): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, vaultState, true);
}

export function findSwapPoolPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("swap_pool"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function findTreasuryPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function findMintAuthorityPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export const CREATOR_SHARE_BPS = 500;
export const BPS = 10000;

export function findSwapPoolHoldVault(
  mint: PublicKey,
  swapPool: PublicKey
): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, swapPool, true);
}

const SWAP_FEE_BPS = 100;
const BPS_DENOMINATOR = 10000;

/** Mirrors the on-chain constant-product formula for a live client-side quote. */
export function quoteSwapOut(
  reserveIn: number,
  reserveOut: number,
  amountIn: number
): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0;
  const amountInAfterFee = (amountIn * (BPS_DENOMINATOR - SWAP_FEE_BPS)) / BPS_DENOMINATOR;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

// Display formatting lives in lib/amount.ts alongside the exact parsing that
// has to agree with it. Re-exported here so existing imports keep working.
export { formatAmount, parseAmount, formatCompact } from "./amount";
