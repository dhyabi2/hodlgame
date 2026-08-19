import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Holder } from "../target/types/holder";
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
  getAccount,
  getMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { expect } from "chai";

const DECIMALS = 6;
const CREATOR_SHARE_BPS = 500;
const BPS = 10000;
const UNIT = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));

function pda(seeds: (string | PublicKey | Buffer)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    seeds.map((s) => {
      if (typeof s === "string") return Buffer.from(s);
      if (s instanceof PublicKey) return s.toBuffer();
      return Buffer.from(s);
    }),
    programId
  )[0];
}

async function send(connection: anchor.web3.Connection, tx: Transaction, signers: Keypair[]) {
  const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
  return sig;
}

/** Best-effort extraction of an Anchor/program error into a searchable string. */
function errText(e: unknown): string {
  const err = e as any;
  const parts = [err?.message, err?.error?.errorCode?.name, err?.error?.errorMessage];
  const logs = Array.isArray(err?.logs) ? err.logs.join(" ") : "";
  return parts.filter(Boolean).join(" ") + " " + logs;
}

async function createMintWithAuthority(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: Keypair,
  mintAuthority: PublicKey,
  decimals = DECIMALS
): Promise<PublicKey> {
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, decimals, mintAuthority, null)
  );
  await send(connection, tx, [payer, mint]);
  return mint.publicKey;
}

async function ensureAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
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

interface Launch {
  mint: PublicKey;
  vaultState: PublicKey;
  stakeVault: PublicKey;
  treasury: PublicKey;
  mintAuthority: PublicKey;
  swapPool: PublicKey;
  creatorAta: PublicKey;
  treasuryAta: PublicKey;
  vaultAta: PublicKey;
  stakeAta: PublicKey;
  holdVault: PublicKey;
  supply: BN;
  creatorShare: BN;
  communityShare: BN;
}

async function launch(
  program: Program<Holder>,
  provider: anchor.AnchorProvider,
  payer: Keypair,
  totalSupply: number,
  poolSol: number
): Promise<Launch> {
  const connection = provider.connection;

  // 1. Create the mint with mint authority = the `mint_authority` PDA.
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const mintAuthority = pda(["mint_authority", mint], program.programId);
  await createMintWithAuthority(connection, payer, mintKp, mintAuthority);

  // Derive PDAs.
  const vaultState = pda(["vault_state", mint], program.programId);
  const stakeVault = pda(["stake_vault", mint], program.programId);
  const treasury = pda(["treasury", mint], program.programId);
  const swapPool = pda(["swap_pool", mint], program.programId);

  // 2. Create the four token accounts.
  const creatorAta = await ensureAta(connection, payer, mint, payer.publicKey);
  const vaultAta = await ensureAta(connection, payer, mint, vaultState);
  const stakeAta = await ensureAta(connection, payer, mint, stakeVault);
  const treasuryAta = await ensureAta(connection, payer, mint, treasury);

  // 3. initialize.
  await program.methods
    .initialize()
    .accounts({
      vaultState,
      stakeVault,
      mint,
      authority: payer.publicKey,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // 4. mint_supply — 5% creator / 95% treasury.
  const supply = new BN(totalSupply * 10 ** DECIMALS);
  const creatorShare = supply.muln(CREATOR_SHARE_BPS).divn(BPS);
  const communityShare = supply.sub(creatorShare);
  await program.methods
    .mintSupply(supply)
    .accounts({
      vaultState,
      mint,
      mintAuthority,
      treasury,
      treasuryTokenAccount: treasuryAta,
      creatorTokenAccount: creatorAta,
      authority: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // 5. initialize_pool — SOL from creator, tokens from treasury.
  const holdVault = await getAssociatedTokenAddress(mint, swapPool, true);
  await program.methods
    .initializePool(new BN(poolSol * LAMPORTS_PER_SOL), communityShare)
    .accounts({
      vaultState,
      swapPool,
      mint,
      holdVault,
      treasury,
      treasuryTokenAccount: treasuryAta,
      authority: payer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // 6. renounce.
  await program.methods
    .renounce()
    .accounts({ vaultState, mint, mintAuthority, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();

  return {
    mint,
    vaultState,
    stakeVault,
    treasury,
    mintAuthority,
    swapPool,
    creatorAta,
    treasuryAta,
    vaultAta,
    stakeAta,
    holdVault,
    supply,
    creatorShare,
    communityShare,
  };
}

describe("holdfun", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.Holder as Program<Holder>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  it("mints exactly 5% to the creator and 95% to the community", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);

    const creator = await getAccount(provider.connection, L.creatorAta);
    const treasury = await getAccount(provider.connection, L.treasuryAta);
    const pool = await getAccount(provider.connection, L.holdVault);
    const mint = await getMint(provider.connection, L.mint);

    expect(creator.amount.toString()).to.eq(L.creatorShare.toString());
    // The community's 95% is seeded into the pool from the treasury.
    expect(pool.amount.toString()).to.eq(L.communityShare.toString());
    expect(treasury.amount.toString()).to.eq("0");
    // 5% cap, enforced: creatorShare * 100 <= supply * 5.
    expect(L.creatorShare.muln(100).lte(L.supply.muln(5))).to.be.true;
    // Total supply matches.
    expect(mint.supply.toString()).to.eq(L.supply.toString());
    // Mint authority destroyed.
    expect(mint.mintAuthority).to.be.null;
  });

  it("mint_supply can only run once", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);
    try {
      await program.methods
        .mintSupply(L.supply)
        .accounts({
          vaultState: L.vaultState,
          mint: L.mint,
          mintAuthority: L.mintAuthority,
          treasury: L.treasury,
          treasuryTokenAccount: L.treasuryAta,
          creatorTokenAccount: L.creatorAta,
          authority: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("second mint_supply should have failed");
    } catch (e: any) {
      expect(errText(e)).to.contain("SupplyAlreadyMinted");
    }
  });

  it("cannot allocate more than 5% regardless of supply size", async () => {
    // Odd supply — the floor division must still keep the creator <= 5%.
    const L = await launch(program, provider, payer, 333_333, 1);
    const creator = await getAccount(provider.connection, L.creatorAta);
    expect(creator.amount.toString()).to.eq(L.creatorShare.toString());
    expect(L.creatorShare.muln(100).lte(L.supply.muln(5))).to.be.true;
  });

  it("stake then unstake burns 5%, pays 80%, funds the vault 15%", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);
    const user = Keypair.generate();
    const connection = provider.connection;
    await connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
    // Let the airdrop confirm.
    await new Promise((r) => setTimeout(r, 500));
    const userAta = await ensureAta(connection, payer, L.mint, user.publicKey);

    // Give the user some tokens from the creator's 5%.
    const creatorAcct = await getAccount(connection, L.creatorAta);
    const stakeAmount = UNIT(10);
    // Transfer 10 tokens creator -> user.
    {
      const tx = new Transaction().add(
        createTransferInstruction(
          L.creatorAta,
          userAta,
          payer.publicKey,
          BigInt(stakeAmount.toString())
        )
      );
      await send(connection, tx, [payer]);
    }

    const supplyBefore = (await getMint(connection, L.mint)).supply;

    // Stake.
    const stakeAccount = pda(["stake_account", L.vaultState, user.publicKey], program.programId);
    await program.methods
      .stake(stakeAmount)
      .accounts({
        vaultState: L.vaultState,
        stakeVault: L.stakeVault,
        mint: L.mint,
        stakeAccount,
        stakeTokenAccount: L.stakeAta,
        userTokenAccount: userAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    // Unstake the full amount.
    await program.methods
      .unstake(stakeAmount)
      .accounts({
        vaultState: L.vaultState,
        stakeVault: L.stakeVault,
        mint: L.mint,
        stakeAccount,
        stakeTokenAccount: L.stakeAta,
        vaultTokenAccount: L.vaultAta,
        userTokenAccount: userAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    const userAcct = await getAccount(connection, userAta);
    const supplyAfter = (await getMint(connection, L.mint)).supply;
    const vaultAcct = await getAccount(connection, L.vaultAta);

    const tax = stakeAmount.muln(2000).divn(10000);
    const burn = tax.muln(2500).divn(10000);
    const rebate = tax.sub(burn);
    const toUser = stakeAmount.sub(tax);

    expect(userAcct.amount.toString()).to.eq(toUser.toString());
    expect((supplyBefore - supplyAfter).toString()).to.eq(burn.toString());
    // 15% landed in the rebate vault (minus nothing — first unstake).
    expect(vaultAcct.amount.toString()).to.eq(rebate.toString());
  });

  it("claim_rebate pays accrued rebates to a staker", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);
    const user = Keypair.generate();
    const connection = provider.connection;
    await connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 500));
    const userAta = await ensureAta(connection, payer, L.mint, user.publicKey);

    // Fund the user with tokens from the creator.
    const stakeAmount = UNIT(1_000);
    {
      const tx = new Transaction().add(
        createTransferInstruction(L.creatorAta, userAta, payer.publicKey, BigInt(stakeAmount.toString()))
      );
      await send(connection, tx, [payer]);
    }

    const stakeAccount = pda(["stake_account", L.vaultState, user.publicKey], program.programId);
    await program.methods
      .stake(stakeAmount)
      .accounts({
        vaultState: L.vaultState,
        stakeVault: L.stakeVault,
        mint: L.mint,
        stakeAccount,
        stakeTokenAccount: L.stakeAta,
        userTokenAccount: userAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    // Seed the vault with a rebate so there is something to claim.
    const rebate = UNIT(50);
    {
      const tx = new Transaction().add(
        createTransferInstruction(L.creatorAta, L.vaultAta, payer.publicKey, BigInt(rebate.toString()))
      );
      await send(connection, tx, [payer]);
    }

    // Let points accrue while the user is staked.
    await new Promise((r) => setTimeout(r, 2000));

    // sync_rewards distributes the inflow to reward_per_point (now that there
    // are accrued points to weight it against).
    await program.methods
      .syncRewards()
      .accounts({
        vaultState: L.vaultState,
        mint: L.mint,
        vaultTokenAccount: L.vaultAta,
      })
      .rpc();

    const before = await getAccount(connection, userAta);
    await program.methods
      .claimRebate()
      .accounts({
        vaultState: L.vaultState,
        mint: L.mint,
        stakeAccount,
        vaultTokenAccount: L.vaultAta,
        userTokenAccount: userAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();
    const after = await getAccount(connection, userAta);

    // The user received *something* — proving the debt is no longer zeroed
    // before pending is computed.
    expect(new BN(after.amount.toString()).gt(new BN(before.amount.toString()))).to.be.true;
  });

  it("swaps SOL for tokens and back", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);
    const user = Keypair.generate();
    const connection = provider.connection;
    await connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 500));
    const userAta = await ensureAta(connection, payer, L.mint, user.publicKey);

    const solIn = new BN(100_000_000); // 0.1 SOL
    await program.methods
      .swapSolForHold(solIn, new BN(0))
      .accounts({
        mint: L.mint,
        swapPool: L.swapPool,
        holdVault: L.holdVault,
        userTokenAccount: userAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    const got = await getAccount(connection, userAta);
    expect(new BN(got.amount.toString()).gtn(0)).to.be.true;

    // Swap the tokens back for SOL.
    await program.methods
      .swapHoldForSol(new BN(got.amount.toString()), new BN(0))
      .accounts({
        mint: L.mint,
        swapPool: L.swapPool,
        holdVault: L.holdVault,
        userTokenAccount: userAta,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const after = await getAccount(connection, userAta);
    expect(after.amount.toString()).to.eq("0");
  });

  it("rejects staking zero and over-withdrawing", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);
    const user = Keypair.generate();
    const connection = provider.connection;
    await connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 500));
    const userAta = await ensureAta(connection, payer, L.mint, user.publicKey);
    const stakeAccount = pda(["stake_account", L.vaultState, user.publicKey], program.programId);

    try {
      await program.methods
        .stake(new BN(0))
        .accounts({
          vaultState: L.vaultState,
          stakeVault: L.stakeVault,
          mint: L.mint,
          stakeAccount,
          stakeTokenAccount: L.stakeAta,
          userTokenAccount: userAta,
          user: user.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user])
        .rpc();
      expect.fail("staking zero should fail");
    } catch (e: any) {
      expect(errText(e)).to.contain("ZeroAmount");
    }

    // Fund the user and stake a little, then try to withdraw more than staked.
    const fund = UNIT(5);
    {
      const tx = new Transaction().add(
        createTransferInstruction(L.creatorAta, userAta, payer.publicKey, BigInt(fund.toString()))
      );
      await send(connection, tx, [payer]);
    }
    await program.methods
      .stake(fund)
      .accounts({
        vaultState: L.vaultState,
        stakeVault: L.stakeVault,
        mint: L.mint,
        stakeAccount,
        stakeTokenAccount: L.stakeAta,
        userTokenAccount: userAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    try {
      await program.methods
        .unstake(UNIT(10))
        .accounts({
          vaultState: L.vaultState,
          stakeVault: L.stakeVault,
          mint: L.mint,
          stakeAccount,
          stakeTokenAccount: L.stakeAta,
          vaultTokenAccount: L.vaultAta,
          userTokenAccount: userAta,
          user: user.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user])
        .rpc();
      expect.fail("over-withdrawing should fail");
    } catch (e: any) {
      expect(errText(e)).to.contain("InsufficientStake");
    }
  });

  it("add_liquidity deepens the pool from the treasury", async () => {
    const L = await launch(program, provider, payer, 1_000_000, 1);
    const connection = provider.connection;

    // Simulate a treasury reserve (e.g. a launch that seeded less than 95%).
    const reserve = UNIT(10_000);
    {
      const tx = new Transaction().add(
        createTransferInstruction(
          L.creatorAta,
          L.treasuryAta,
          payer.publicKey,
          BigInt(reserve.toString())
        )
      );
      await send(connection, tx, [payer]);
    }

    const poolBefore = await connection.getBalance(L.swapPool);
    const holdBefore = await getAccount(connection, L.holdVault);

    const solIn = new BN(500_000_000); // 0.5 SOL
    await program.methods
      .addLiquidity(solIn, reserve)
      .accounts({
        vaultState: L.vaultState,
        swapPool: L.swapPool,
        mint: L.mint,
        holdVault: L.holdVault,
        treasury: L.treasury,
        treasuryTokenAccount: L.treasuryAta,
        authority: payer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const poolAfter = await connection.getBalance(L.swapPool);
    const holdAfter = await getAccount(connection, L.holdVault);
    const treasuryAfter = await getAccount(connection, L.treasuryAta);

    expect(poolAfter - poolBefore).to.eq(500_000_000);
    expect((holdAfter.amount - holdBefore.amount).toString()).to.eq(reserve.toString());
    expect(treasuryAfter.amount.toString()).to.eq("0");
  });
});
