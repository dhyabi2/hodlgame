// Migrations are an early feature. Currently, they are nothing more than this
// single deploy script that is invoked by `anchor deploy`.
//
// This mirrors the client-side launch wizard in app/lib/launch.ts: create a mint
// whose authority is the program PDA, open the token accounts, initialize the
// vaults, mint the supply (5% creator / 95% community), seed the pool from the
// treasury, and renounce the mint authority.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const DECIMALS = 6;
const MINT_SUPPLY = 1_000_000_000; // 1B tokens
const POOL_SOL = 2; // SOL seeded into the pool
const CREATOR_SHARE_BPS = 500;

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);
  const program = anchor.workspace.Holder as Program<any>;
  const payer = provider.wallet.publicKey;

  console.log("Deployer:", payer.toBase58());

  // Create the mint with mint authority = program PDA (never the deployer).
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const [realMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), mint.toBuffer()],
    program.programId
  );

  await createMint(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    realMintAuthority, // mint authority = program PDA
    null, // no freeze authority
    DECIMALS,
    undefined,
    { skipPreflight: false },
    TOKEN_PROGRAM_ID,
    mintKeypair
  );
  console.log("Mint:", mint.toBase58());

  // Derive PDAs.
  const [vaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), mint.toBuffer()],
    program.programId
  );
  const [stakeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_vault"), mint.toBuffer()],
    program.programId
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), mint.toBuffer()],
    program.programId
  );

  // Create the four token accounts the launch needs.
  const creatorAta = await getAssociatedTokenAddress(mint, payer);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultState, true);
  const stakeAta = await getAssociatedTokenAddress(mint, stakeVault, true);
  const treasuryAta = await getAssociatedTokenAddress(mint, treasury, true);
  for (const { ata, authority } of [
    { ata: creatorAta, authority: payer },
    { ata: vaultAta, authority: vaultState },
    { ata: stakeAta, authority: stakeVault },
    { ata: treasuryAta, authority: treasury },
  ]) {
    const exists = await provider.connection.getAccountInfo(ata);
    if (!exists) {
      await createAssociatedTokenAccount(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        mint,
        authority,
        { skipPreflight: false },
        undefined,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    }
  }

  // Initialize the vault state + stake vault.
  await program.methods
    .initialize()
    .accounts({
      vaultState,
      stakeVault,
      mint,
      authority: payer,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log("Vault initialized:", vaultState.toBase58());

  // Mint the supply: 5% creator / 95% community treasury.
  await program.methods
    .mintSupply(new anchor.BN(MINT_SUPPLY * 10 ** DECIMALS))
    .accounts({
      vaultState,
      mint,
      mintAuthority: realMintAuthority,
      treasury,
      treasuryTokenAccount: treasuryAta,
      creatorTokenAccount: creatorAta,
      authority: payer,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
  console.log("Supply minted: 5% creator / 95% treasury");

  // Seed the pool: creator's SOL + the community's 95%.
  const [swapPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap_pool"), mint.toBuffer()],
    program.programId
  );
  const holdVault = await getAssociatedTokenAddress(mint, swapPool, true);
  const supply = new anchor.BN(MINT_SUPPLY * 10 ** DECIMALS);
  const creatorShare = supply.muln(CREATOR_SHARE_BPS).divn(10000);
  const communityShare = supply.sub(creatorShare);
  await program.methods
    .initializePool(new anchor.BN(POOL_SOL * anchor.web3.LAMPORTS_PER_SOL), communityShare)
    .accounts({
      vaultState,
      swapPool,
      mint,
      holdVault,
      treasury,
      treasuryTokenAccount: treasuryAta,
      authority: payer,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log("Pool seeded:", swapPool.toBase58());

  // Renounce the mint authority forever.
  await program.methods
    .renounce()
    .accounts({
      vaultState,
      mint,
      mintAuthority: realMintAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
  console.log("Mint authority renounced");

  // Write deployment artifacts for the frontend.
  const root = path.resolve(__dirname, "..");
  const envPath = path.join(root, "..", "app", ".env.local");
  const envContent = `NEXT_PUBLIC_NETWORK=devnet\nNEXT_PUBLIC_MINT=${mint.toBase58()}\nNEXT_PUBLIC_PROGRAM_ID=${program.programId.toBase58()}\n`;
  fs.writeFileSync(envPath, envContent);
  console.log("Wrote", envPath);

  const addressesPath = path.join(root, "..", "app", "lib", "addresses.json");
  fs.writeFileSync(
    addressesPath,
    JSON.stringify(
      {
        network: "devnet",
        mint: mint.toBase58(),
        programId: program.programId.toBase58(),
        vaultState: vaultState.toBase58(),
        stakeVault: stakeVault.toBase58(),
        treasury: treasury.toBase58(),
      },
      null,
      2
    )
  );
  console.log("Wrote", addressesPath);
};
