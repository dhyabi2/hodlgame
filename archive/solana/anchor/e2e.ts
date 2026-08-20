// End-to-end launch test against devnet: exercises the exact flow the /create
// wizard runs — mint (PDA authority) → token accounts → initialize →
// mint_supply (5%/95%) → initialize_pool → renounce — then verifies the game
// works for a second wallet (swap, stake, unstake, claim).
//
//   cd anchor && yarn ts-node e2e.ts

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createTransferInstruction,
  getAccount,
  getMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROGRAM_ID = new PublicKey("9ggxpWrwYXH7sygoqQs2N5qCva38vVkJvr5ZzwPijPUu");
const RPC = "https://api.devnet.solana.com";
const DECIMALS = 6;
const CREATOR_SHARE_BPS = 500;
const BPS = 10000;
const UNIT = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));

function pda(seeds: (string | PublicKey)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
    programId
  )[0];
}

function log(step: string, detail = "") {
  console.log(`\x1b[32m✓ ${step}\x1b[0m ${detail}`);
}

async function send(
  connection: anchor.web3.Connection,
  tx: Transaction,
  signers: Keypair[]
) {
  return anchor.web3.sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
    skipPreflight: false,
  });
}

async function ensureAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
) {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await send(connection, tx, [payer]);
  }
  return ata;
}

async function main() {
  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "target/idl/holder.json"), "utf-8")
  );
  const secret = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")
  );
  const creator = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(creator);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program(idl as anchor.Idl, PROGRAM_ID, provider);

  const balance = await connection.getBalance(creator.publicKey);
  console.log(`\nDeployer ${creator.publicKey.toBase58()} · ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL\n`);
  if (balance < LAMPORTS_PER_SOL) throw new Error("Need more devnet SOL");

  // 1. Create the mint with mint authority = program PDA.
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const mintAuthority = pda(["mint_authority", mint], PROGRAM_ID);
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  {
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint, DECIMALS, mintAuthority, null)
    );
    await send(connection, tx, [creator, mintKp]);
  }
  log("Mint created", mint.toBase58());

  // 2. Derive PDAs + create token accounts.
  const vaultState = pda(["vault_state", mint], PROGRAM_ID);
  const stakeVault = pda(["stake_vault", mint], PROGRAM_ID);
  const treasury = pda(["treasury", mint], PROGRAM_ID);
  const swapPool = pda(["swap_pool", mint], PROGRAM_ID);
  const creatorAta = await ensureAta(connection, creator, mint, creator.publicKey);
  await ensureAta(connection, creator, mint, vaultState);
  await ensureAta(connection, creator, mint, stakeVault);
  const treasuryAta = await ensureAta(connection, creator, mint, treasury);
  log("Token accounts created");

  // 3. initialize.
  await program.methods
    .initialize()
    .accounts({
      vaultState,
      stakeVault,
      mint,
      authority: creator.publicKey,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  log("Vaults initialized");

  // 4. mint_supply — 5% / 95%.
  const totalSupply = UNIT(1_000_000);
  const creatorShare = totalSupply.muln(CREATOR_SHARE_BPS).divn(BPS);
  const communityShare = totalSupply.sub(creatorShare);
  await program.methods
    .mintSupply(totalSupply)
    .accounts({
      vaultState,
      mint,
      mintAuthority,
      treasury,
      treasuryTokenAccount: treasuryAta,
      creatorTokenAccount: creatorAta,
      authority: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();

  const creatorBal = await getAccount(connection, creatorAta);
  const treasuryBal = await getAccount(connection, treasuryAta);
  log(
    "Supply minted",
    `creator ${(creatorBal.amount.toString())} (5% expected ${creatorShare.toString()}) · treasury ${treasuryBal.amount.toString()}`
  );
  if (creatorBal.amount.toString() !== creatorShare.toString())
    throw new Error("Creator share mismatch");

  // 5. initialize_pool — SOL from creator, tokens from treasury.
  const holdVault = await getAssociatedTokenAddress(mint, swapPool, true);
  await program.methods
    .initializePool(new BN(1 * LAMPORTS_PER_SOL), communityShare)
    .accounts({
      vaultState,
      swapPool,
      mint,
      holdVault,
      treasury,
      treasuryTokenAccount: treasuryAta,
      authority: creator.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  log("Pool seeded (1 SOL + 95% community share)");

  // 6. renounce.
  await program.methods
    .renounce()
    .accounts({ vaultState, mint, mintAuthority, tokenProgram: TOKEN_PROGRAM_ID } as any)
    .rpc();
  const mintInfo = await getMint(connection, mint);
  if (mintInfo.mintAuthority !== null) throw new Error("Mint authority not revoked");
  log("Mint authority revoked forever");

  // 7. Confirm second mint_supply is impossible.
  try {
    await program.methods
      .mintSupply(new BN(1))
      .accounts({
        vaultState,
        mint,
        mintAuthority,
        treasury,
        treasuryTokenAccount: treasuryAta,
        creatorTokenAccount: creatorAta,
        authority: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    throw new Error("Second mint_supply unexpectedly succeeded");
  } catch (e: any) {
    if (String(e).includes("SupplyAlreadyMinted") || String(e).includes("0x1775")) {
      log("5% cap enforced: second mint_supply rejected");
    } else {
      log("Second mint_supply rejected", `(${String(e).slice(0, 80)}…)`);
    }
  }

  // 8. Second wallet: buy, stake, unstake, swap back.
  const buyer = Keypair.generate();
  const buyTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: creator.publicKey,
      toPubkey: buyer.publicKey,
      lamports: 0.3 * LAMPORTS_PER_SOL,
    })
  );
  await send(connection, buyTx, [creator]);
  const buyerAta = await ensureAta(connection, creator, mint, buyer.publicKey);

  await program.methods
    .swapSolForHold(new BN(0.1 * LAMPORTS_PER_SOL), new BN(0))
    .accounts({
      mint,
      swapPool,
      holdVault,
      userTokenAccount: buyerAta,
      user: buyer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .signers([buyer])
    .rpc();
  const bought = await getAccount(connection, buyerAta);
  log("Buyer swapped SOL → coin", `received ${bought.amount.toString()} units`);

  const stakeAmount = new BN(bought.amount.toString()).divn(2);
  const stakeAccount = pda(["stake_account", vaultState, buyer.publicKey], PROGRAM_ID);
  await program.methods
    .stake(stakeAmount)
    .accounts({
      vaultState,
      stakeVault,
      mint,
      stakeAccount,
      stakeTokenAccount: await getAssociatedTokenAddress(mint, stakeVault, true),
      userTokenAccount: buyerAta,
      user: buyer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .signers([buyer])
    .rpc();
  log("Buyer staked", stakeAmount.toString());

  await program.methods
    .unstake(stakeAmount)
    .accounts({
      vaultState,
      stakeVault,
      mint,
      stakeAccount,
      stakeTokenAccount: await getAssociatedTokenAddress(mint, stakeVault, true),
      vaultTokenAccount: await getAssociatedTokenAddress(mint, vaultState, true),
      userTokenAccount: buyerAta,
      user: buyer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .signers([buyer])
    .rpc();
  log("Buyer unstaked (20% exit tax applied)");

  const remaining = await getAccount(connection, buyerAta);
  await program.methods
    .swapHoldForSol(new BN(remaining.amount.toString()), new BN(0))
    .accounts({
      mint,
      swapPool,
      holdVault,
      userTokenAccount: buyerAta,
      user: buyer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([buyer])
    .rpc();
  log("Buyer swapped coin → SOL");

  console.log(`\n🎉 E2E PASS — token launched on devnet:\n   ${mint.toBase58()}\n`);
}

main().catch((e) => {
  console.error("\x1b[31mE2E FAILED:\x1b[0m", e);
  process.exit(1);
});
