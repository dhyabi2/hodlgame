// Migrations are an early feature. Currently, they are nothing more than this
// single deploy script that is invoked by `anchor deploy`.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
// import { Holder } from "../target/types/holder";
import * as fs from "fs";
import * as path from "path";

const DECIMALS = 6;
const MINT_SUPPLY = 1_000_000_000; // 1B tokens

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  const program = anchor.workspace.Holder as Program<any>;
  const payer = provider.wallet.publicKey;

  console.log("Deployer:", payer.toBase58());

  // Create the HOLD mint.
  const mint = await createMint(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    payer,
    null,
    DECIMALS
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

  // Initialize the vault.
  await program.methods
    .initialize()
    .accounts({
      vaultState,
      stakeVault,
      mint,
      vaultTokenAccount: await anchor.utils.token.associatedAddress({
        mint,
        owner: vaultState,
      }),
      stakeTokenAccount: await anchor.utils.token.associatedAddress({
        mint,
        owner: stakeVault,
      }),
      authority: payer,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log("Vault initialized:", vaultState.toBase58());

  // Mint a test supply to the deployer.
  const deployerAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    mint,
    payer
  );
  await mintTo(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    mint,
    deployerAta.address,
    payer,
    MINT_SUPPLY * 10 ** DECIMALS
  );
  console.log("Minted", MINT_SUPPLY, "HOLD to deployer ATA:", deployerAta.address.toBase58());

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
      },
      null,
      2
    )
  );
  console.log("Wrote", addressesPath);
};
