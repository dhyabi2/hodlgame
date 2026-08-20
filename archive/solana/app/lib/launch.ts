"use client";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import {
  PROGRAM_ID as METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
} from "@metaplex-foundation/mpl-token-metadata";
import { BN } from "@coral-xyz/anchor";
import { WalletContextState } from "@solana/wallet-adapter-react";
import {
  BPS,
  CREATOR_SHARE_BPS,
  findMintAuthorityPDA,
  findStakeVaultPDA,
  findSwapPoolPDA,
  findTreasuryPDA,
  findVaultStatePDA,
  getProgram,
  getProvider,
} from "./program";
import { parseAmount } from "./amount";

/**
 * Launching a HoldFun token does NOT require deploying a program.
 *
 * Every PDA in the program is seeded by mint — `[b"vault_state", mint]`,
 * `[b"stake_vault", mint]`, `[b"swap_pool", mint]`, `[b"treasury", mint]`,
 * `[b"mint_authority", mint]` — and the on-chain program is multi-tenant: one
 * deployment serves every token anyone creates.
 *
 * The defining rule — the one the whole product exists to enforce — is that the
 * creator can never own more than 5% of the supply. It is enforced on-chain:
 * the mint authority is a program PDA, `mint_supply` mints exactly
 * `CREATOR_SHARE_BPS` (5%) to the creator and the remaining 95% to a community
 * treasury, and `mint_supply` can only run once. There is no path to more than
 * 5%, and `renounce` removes the mint authority entirely.
 */

export interface LaunchConfig {
  name: string;
  symbol: string;
  /** Off-chain JSON metadata URI. Optional — wallets fall back to name/symbol. */
  uri: string;
  decimals: number;
  /** Whole tokens, as a decimal string. */
  totalSupply: string;
  /** SOL seeded into the swap pool, as a decimal string. */
  poolSol: string;
  /**
   * Community tokens seeded into the pool, as a decimal string. Empty means
   * "seed the entire 95% community share". Set a smaller amount to keep a
   * reserve in the treasury so you can add liquidity later, in one click.
   */
  poolTokens: string;
}

export type StepId =
  | "mint"
  | "metadata"
  | "atas"
  | "vault"
  | "supply"
  | "pool"
  | "renounce";

export interface LaunchStep {
  id: StepId;
  title: string;
  detail: string;
}

export const LAUNCH_STEPS: LaunchStep[] = [
  { id: "mint", title: "Create the coin", detail: "" },
  { id: "metadata", title: "Name it", detail: "" },
  { id: "atas", title: "Open accounts", detail: "" },
  { id: "vault", title: "Open the vault", detail: "" },
  { id: "supply", title: "Mint supply", detail: "You get 5%, the rest 95%." },
  { id: "pool", title: "Seed the pool", detail: "" },
  { id: "renounce", title: "Lock it", detail: "" },
];

export interface StepResult {
  id: StepId;
  signature: string;
  skipped?: boolean;
}

export interface LaunchState {
  mint: string;
  completed: StepResult[];
}

const STORAGE_KEY = "holdfun:launchInProgress";

/**
 * A launch is several transactions, and a wallet rejection or an RPC hiccup
 * halfway through would otherwise strand a half-created token with no way back.
 * Progress is checkpointed so the wizard can resume instead of restarting.
 */
export function saveProgress(state: LaunchState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadProgress(): LaunchState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LaunchState) : null;
  } catch {
    return null;
  }
}

export function clearProgress() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function findMetadataPDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  )[0];
}

/** Rough cost of the whole launch, excluding the SOL seeded into the pool. */
export async function estimateLaunchCost(connection: Connection): Promise<number> {
  const mintRent = await getMinimumBalanceForRentExemptMint(connection);
  // vault_state + stake_vault accounts, 4 token accounts, 1 metadata account,
  // plus per-signature fees. Deliberately generous — under-quoting a cost is
  // worse than over-quoting it.
  const accountRent = await connection.getMinimumBalanceForRentExemption(300);
  const tokenAccountRent = await connection.getMinimumBalanceForRentExemption(165);
  const metadataRent = await connection.getMinimumBalanceForRentExemption(679);
  const total =
    mintRent +
    accountRent * 2 +
    tokenAccountRent * 4 +
    metadataRent +
    7 * 5000;
  return total / LAMPORTS_PER_SOL;
}

export interface LaunchContext {
  connection: Connection;
  wallet: WalletContextState;
  config: LaunchConfig;
  /** Regenerated only on a fresh launch; reused when resuming. */
  mintKeypair: Keypair | null;
  mint: PublicKey;
}

async function send(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
  signers: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey!;
  if (signers.length > 0) tx.partialSign(...signers);
  const signature = await wallet.sendTransaction(tx, connection, {
    signers,
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

/** Step 1 — create and initialize the SPL mint. Mint authority is the program. */
export async function stepCreateMint(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, config, mintKeypair } = ctx;
  if (!mintKeypair) throw new Error("Missing mint keypair — restart the launch.");
  const owner = wallet.publicKey!;
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  const [mintAuthority] = findMintAuthorityPDA(mintKeypair.publicKey);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      config.decimals,
      mintAuthority, // mint authority = program PDA, never the creator
      null // no freeze authority — nobody can ever freeze a holder
    )
  );
  return send(connection, wallet, tx, [mintKeypair]);
}

/** Step 2 — attach Token Metadata so wallets show a name instead of an address. */
export async function stepCreateMetadata(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, config, mint } = ctx;
  const owner = wallet.publicKey!;

  const tx = new Transaction().add(
    createCreateMetadataAccountV3Instruction(
      {
        metadata: findMetadataPDA(mint),
        mint,
        mintAuthority: owner,
        payer: owner,
        updateAuthority: owner,
      },
      {
        createMetadataAccountArgsV3: {
          data: {
            name: config.name.slice(0, 32),
            symbol: config.symbol.slice(0, 10),
            uri: config.uri.slice(0, 200),
            sellerFeeBasisPoints: 0,
            creators: null,
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: null,
        },
      }
    )
  );
  return send(connection, wallet, tx);
}

/** Step 3 — create the four token accounts the launch needs. */
export async function stepCreateAtas(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, mint } = ctx;
  const owner = wallet.publicKey!;
  const [vaultPDA] = findVaultStatePDA(mint);
  const [stakeVaultPDA] = findStakeVaultPDA(mint);
  const [treasuryPDA] = findTreasuryPDA(mint);

  const targets: { ata: PublicKey; authority: PublicKey }[] = [
    { ata: await getAssociatedTokenAddress(mint, owner), authority: owner },
    { ata: await getAssociatedTokenAddress(mint, vaultPDA, true), authority: vaultPDA },
    { ata: await getAssociatedTokenAddress(mint, stakeVaultPDA, true), authority: stakeVaultPDA },
    { ata: await getAssociatedTokenAddress(mint, treasuryPDA, true), authority: treasuryPDA },
  ];

  const tx = new Transaction();
  for (const { ata, authority } of targets) {
    const existing = await connection.getAccountInfo(ata);
    if (!existing) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          owner,
          ata,
          authority,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  if (tx.instructions.length === 0) throw new Error("Token accounts already exist.");
  return send(connection, wallet, tx);
}

/** Step 4 — `initialize`: opens the stake vault and rebate vault for this mint. */
export async function stepInitializeVault(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, mint } = ctx;
  const program = getProgram(getProvider(connection, wallet));
  const [vaultPDA] = findVaultStatePDA(mint);
  const [stakeVaultPDA] = findStakeVaultPDA(mint);

  return program.methods
    .initialize()
    .accounts({
      vaultState: vaultPDA,
      stakeVault: stakeVaultPDA,
      mint,
      authority: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
}

/** Step 5 — `mint_supply`: 5% to the creator, 95% to the community treasury. */
export async function stepMintSupply(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, config, mint } = ctx;
  const program = getProgram(getProvider(connection, wallet));
  const [vaultPDA] = findVaultStatePDA(mint);
  const [mintAuthority] = findMintAuthorityPDA(mint);
  const [treasuryPDA] = findTreasuryPDA(mint);
  const supply = parseAmount(config.totalSupply, config.decimals);
  if (!supply || supply.isZero()) throw new Error("Total supply must be greater than zero.");

  return program.methods
    .mintSupply(supply)
    .accounts({
      vaultState: vaultPDA,
      mint,
      mintAuthority,
      treasury: treasuryPDA,
      treasuryTokenAccount: await getAssociatedTokenAddress(mint, treasuryPDA, true),
      creatorTokenAccount: await getAssociatedTokenAddress(mint, wallet.publicKey!),
      authority: wallet.publicKey!,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
}

/** Step 6 — `initialize_pool`: seed SOL (from the creator) + community tokens
 * (from the treasury) so people can buy in. */
export async function stepSeedPool(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, config, mint } = ctx;
  const program = getProgram(getProvider(connection, wallet));
  const [vaultPDA] = findVaultStatePDA(mint);
  const [swapPoolPDA] = findSwapPoolPDA(mint);
  const [treasuryPDA] = findTreasuryPDA(mint);

  const solLamports = parseAmount(config.poolSol, 9);
  const supply = parseAmount(config.totalSupply, config.decimals);
  if (!solLamports || solLamports.isZero()) throw new Error("Pool SOL must be greater than zero.");
  if (!supply || supply.isZero()) throw new Error("Total supply must be greater than zero.");

  const creatorShare = supply.muln(CREATOR_SHARE_BPS).divn(BPS);
  const communityShare = supply.sub(creatorShare);
  const requested = config.poolTokens.trim() ? parseAmount(config.poolTokens, config.decimals) : null;
  const holdAmount = requested && requested.gtn(0) ? requested : communityShare;
  if (holdAmount.gt(communityShare))
    throw new Error("Pool tokens can't exceed the community share.");

  return program.methods
    .initializePool(solLamports, holdAmount)
    .accounts({
      vaultState: vaultPDA,
      swapPool: swapPoolPDA,
      mint,
      holdVault: await getAssociatedTokenAddress(mint, swapPoolPDA, true),
      treasury: treasuryPDA,
      treasuryTokenAccount: await getAssociatedTokenAddress(mint, treasuryPDA, true),
      authority: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
}

/**
 * Step 7 — `renounce`: destroy the mint authority. The program signs, so this
 * cannot be undone and supply can never change again.
 */
export async function stepRenounce(ctx: LaunchContext): Promise<string> {
  const { connection, wallet, mint } = ctx;
  const program = getProgram(getProvider(connection, wallet));
  const [vaultPDA] = findVaultStatePDA(mint);
  const [mintAuthority] = findMintAuthorityPDA(mint);

  return program.methods
    .renounce()
    .accounts({
      vaultState: vaultPDA,
      mint,
      mintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
}

export const STEP_RUNNERS: Record<
  StepId,
  (ctx: LaunchContext) => Promise<string>
> = {
  mint: stepCreateMint,
  metadata: stepCreateMetadata,
  atas: stepCreateAtas,
  vault: stepInitializeVault,
  supply: stepMintSupply,
  pool: stepSeedPool,
  renounce: stepRenounce,
};

/** Which steps actually run, given the config. */
export function activeSteps(config: LaunchConfig): LaunchStep[] {
  return LAUNCH_STEPS.filter((step) => {
    if (step.id === "metadata") return config.name.trim().length > 0;
    return true;
  });
}

export interface ConfigProblem {
  field: string;
  message: string;
}

/** Validation the wizard runs before it asks the user to sign anything. */
export function validateConfig(
  config: LaunchConfig,
  solBalance: number | null
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (!config.name.trim()) problems.push({ field: "name", message: "Give your token a name." });
  if (config.name.length > 32)
    problems.push({ field: "name", message: "Name must be 32 characters or fewer." });
  if (!config.symbol.trim()) problems.push({ field: "symbol", message: "Give your token a symbol." });
  if (config.symbol.length > 10)
    problems.push({ field: "symbol", message: "Symbol must be 10 characters or fewer." });
  if (!/^[A-Za-z0-9]+$/.test(config.symbol.trim() || "x"))
    problems.push({ field: "symbol", message: "Symbol must be letters and numbers only." });
  if (config.uri && !/^https?:\/\//.test(config.uri))
    problems.push({ field: "uri", message: "Metadata URI must start with http:// or https://." });

  if (config.decimals < 0 || config.decimals > 9)
    problems.push({ field: "decimals", message: "Decimals must be between 0 and 9." });

  const supply = parseAmount(config.totalSupply, config.decimals);
  const sol = parseAmount(config.poolSol, 9);

  if (!supply || supply.isZero())
    problems.push({ field: "totalSupply", message: "Total supply must be greater than zero." });
  else if (supply.ltn(20))
    problems.push({
      field: "totalSupply",
      message: "Total supply must be at least 20 tokens (5% is at least 1 whole token).",
    });

  if (!sol || sol.isZero())
    problems.push({ field: "poolSol", message: "Seed the pool with some SOL or nobody can buy in." });

  if (config.poolTokens.trim()) {
    const pool = parseAmount(config.poolTokens, config.decimals);
    const community = supply
      ? supply.sub(supply.muln(CREATOR_SHARE_BPS).divn(BPS))
      : null;
    if (!pool || pool.isZero())
      problems.push({ field: "poolTokens", message: "Pool tokens must be greater than zero (or leave blank for the full 95%)." });
    else if (community && pool.gt(community))
      problems.push({
        field: "poolTokens",
        message: "Pool tokens can't exceed the community share — leave some in the treasury to add liquidity later.",
      });
  }

  if (sol && solBalance !== null) {
    const needed = Number(sol.toString()) / LAMPORTS_PER_SOL + 0.05;
    if (needed > solBalance)
      problems.push({
        field: "poolSol",
        message: `You have ${solBalance.toFixed(3)} SOL — not enough for this plus ~0.05 SOL of account rent and fees.`,
      });
  }

  return problems;
}

/** Starting price implied by the pool seeding, in SOL per token. */
export function impliedPrice(config: LaunchConfig): number | null {
  const sol = parseAmount(config.poolSol, 9);
  const supply = parseAmount(config.totalSupply, config.decimals);
  if (!sol || !supply || supply.isZero()) return null;
  const creatorShare = supply.muln(CREATOR_SHARE_BPS).divn(BPS);
  const communityShare = supply.sub(creatorShare);
  const pool = config.poolTokens.trim()
    ? parseAmount(config.poolTokens, config.decimals)
    : null;
  const tokenUnits = pool && pool.gtn(0) ? pool : communityShare;
  if (tokenUnits.isZero()) return null;
  const solNum = Number(sol.toString()) / LAMPORTS_PER_SOL;
  const tokenNum = Number(tokenUnits.toString()) / 10 ** config.decimals;
  if (tokenNum === 0) return null;
  return solNum / tokenNum;
}

/** The creator's share of the supply (5%), in raw units. */
export function creatorShareOf(config: LaunchConfig): BN {
  const supply = parseAmount(config.totalSupply, config.decimals);
  if (!supply) return new BN(0);
  return supply.muln(CREATOR_SHARE_BPS).divn(BPS);
}

/** The community's share of the supply (95%), in raw units. */
export function communityShareOf(config: LaunchConfig): BN {
  const supply = parseAmount(config.totalSupply, config.decimals);
  if (!supply) return new BN(0);
  return supply.sub(supply.muln(CREATOR_SHARE_BPS).divn(BPS));
}

export const DEFAULT_CONFIG: LaunchConfig = {
  name: "",
  symbol: "",
  uri: "",
  decimals: 6,
  totalSupply: "1000000",
  poolSol: "1",
  poolTokens: "",
};

export function newMintKeypair(): Keypair {
  return Keypair.generate();
}

export { BN };
