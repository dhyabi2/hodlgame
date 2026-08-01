import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
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

export function formatAmount(amount: BN | number, decimals = 6): string {
  const bn = BN.isBN(amount) ? amount : new BN(amount);
  const divisor = new BN(10).pow(new BN(decimals));
  const whole = bn.div(divisor).toString();
  const frac = bn.mod(divisor).toString().padStart(decimals, "0").slice(0, 4);
  return `${whole}.${frac}`;
}
