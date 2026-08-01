// One-off script: seed the SOL/HOLD swap pool with initial liquidity.
// Run manually (not via `anchor migrate`, which has known env/commitment quirks
// already worked around this session):
//
//   ANCHOR_WALLET=~/.config/solana/id.json yarn ts-node migrations/init_pool.ts
//
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// Initial pool liquidity — arbitrary devnet play-money starting price.
const SOL_SEED = 2; // SOL
const HOLD_SEED = 200_000; // HOLD
const HOLD_DECIMALS = 6;

async function main() {
  const url = "https://api.devnet.solana.com";
  const connection = new anchor.web3.Connection(url, "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const addressesPath = path.resolve(__dirname, "..", "..", "app", "lib", "addresses.json");
  const idlPath = path.resolve(__dirname, "..", "target", "idl", "holder.json");
  const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf-8"));
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const mint = new PublicKey(addresses.mint);
  const programId = new PublicKey(addresses.programId);
  const vaultState = new PublicKey(addresses.vaultState);
  const program = new Program(idl as anchor.Idl, programId, provider);

  const [swapPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap_pool"), mint.toBuffer()],
    programId
  );
  const holdVault = await getAssociatedTokenAddress(mint, swapPool, true);
  const authorityTokenAccount = await getAssociatedTokenAddress(
    mint,
    provider.wallet.publicKey
  );

  console.log("Authority:", provider.wallet.publicKey.toBase58());
  console.log("Swap pool PDA:", swapPool.toBase58());
  console.log("Hold vault:", holdVault.toBase58());

  const solAmount = new BN(SOL_SEED * anchor.web3.LAMPORTS_PER_SOL);
  const holdAmount = new BN(HOLD_SEED * 10 ** HOLD_DECIMALS);

  const sig = await program.methods
    .initializePool(solAmount, holdAmount)
    .accounts({
      vaultState,
      swapPool,
      mint,
      holdVault,
      authorityTokenAccount,
      authority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  console.log("Pool initialized:", sig);
  console.log(`Seeded with ${SOL_SEED} SOL / ${HOLD_SEED} HOLD`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
