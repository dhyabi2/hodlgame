// Reusable script: top up the SOL/HOLD swap pool's liquidity anytime.
// No code changes or redeploy needed — this just calls the existing
// `add_liquidity` instruction with whatever amounts you pass in.
//
//   ANCHOR_WALLET=~/.config/solana/id.json yarn ts-node migrations/add_liquidity.ts <solAmount> <holdAmount>
//
// Either amount may be 0 (e.g. `... 5 0` to add only SOL), but not both.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const HOLD_DECIMALS = 6;

async function main() {
  const [, , solArg, holdArg] = process.argv;
  if (solArg === undefined || holdArg === undefined) {
    console.error(
      "Usage: yarn ts-node migrations/add_liquidity.ts <solAmount> <holdAmount>"
    );
    process.exit(1);
  }
  const solSeed = parseFloat(solArg);
  const holdSeed = parseFloat(holdArg);
  if (Number.isNaN(solSeed) || Number.isNaN(holdSeed) || (solSeed <= 0 && holdSeed <= 0)) {
    console.error("Both amounts must be numbers, and at least one must be > 0.");
    process.exit(1);
  }

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
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), mint.toBuffer()],
    programId
  );
  const holdVault = await getAssociatedTokenAddress(mint, swapPool, true);
  const treasuryTokenAccount = await getAssociatedTokenAddress(mint, treasury, true);

  console.log("Authority:", provider.wallet.publicKey.toBase58());
  console.log("Swap pool PDA:", swapPool.toBase58());
  console.log(`Adding ${solSeed} SOL / ${holdSeed} HOLD...`);

  const solAmount = new BN(Math.floor(solSeed * anchor.web3.LAMPORTS_PER_SOL));
  const holdAmount = new BN(Math.floor(holdSeed * 10 ** HOLD_DECIMALS));

  const sig = await program.methods
    .addLiquidity(solAmount, holdAmount)
    .accounts({
      vaultState,
      swapPool,
      mint,
      holdVault,
      treasury,
      treasuryTokenAccount,
      authority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();

  console.log("Liquidity added:", sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
