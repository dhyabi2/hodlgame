// One-off script: create the Diamond Raffle account.
// Run manually:
//
//   ANCHOR_WALLET=~/.config/solana/id.json yarn ts-node migrations/init_raffle.ts
//
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

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

  const [rafflePool] = PublicKey.findProgramAddressSync(
    [Buffer.from("raffle_pool"), mint.toBuffer()],
    programId
  );

  console.log("Authority:", provider.wallet.publicKey.toBase58());
  console.log("Raffle pool PDA:", rafflePool.toBase58());

  const sig = await program.methods
    .initializeRaffle()
    .accounts({
      vaultState,
      rafflePool,
      mint,
      authority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  console.log("Raffle initialized:", sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
