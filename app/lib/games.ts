"use client";

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, getMint } from "@solana/spl-token";
import { Metadata, PROGRAM_ID as METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import { PROGRAM_ID, findSwapPoolPDA } from "./program";
import idl from "./idl.json";

export interface GameSummary {
  mint: string;
  vaultState: string;
  authority: string;
  totalStaked: BN;
  decimals: number;
  name: string;
  symbol: string;
  /** null when the mint account couldn't be read. */
  supply: BN | null;
  /** The creator's allocation at launch (5%), from the vault state. */
  creatorShare: BN | null;
  /** Unix seconds when the vault was created (for the "New" list). */
  createdAt: number;
  /** SOL per token, from the swap pool. null when no pool. */
  priceSol: number | null;
  /** Price × supply, in SOL. null when no price or supply. */
  marketCapSol: number | null;
  /** 24h price change %, from the indexer. null when no history yet. */
  change24hPct: number | null;
  /** The two signals that decide whether a stranger's token is safe to touch. */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  poolSol: number | null;
  poolTokens: BN | null;
}

function metadataPDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  )[0];
}

/** Reads on-chain Token Metadata. Falls back to a shortened mint when absent. */
export async function readTokenMeta(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string }> {
  try {
    const info = await connection.getAccountInfo(metadataPDA(mint));
    if (!info) return { name: "", symbol: "" };
    const [meta] = Metadata.deserialize(info.data);
    // Metaplex pads these strings with NULs to a fixed width.
    return {
      name: meta.data.name.replace(/\0/g, "").trim(),
      symbol: meta.data.symbol.replace(/\0/g, "").trim(),
    };
  } catch {
    return { name: "", symbol: "" };
  }
}

function readProgram(connection: Connection) {
  const provider = new AnchorProvider(
    connection,
    {} as any,
    AnchorProvider.defaultOptions()
  );
  return new Program<any>(idl as any, PROGRAM_ID, provider);
}

/** Everything the game view needs about one token, in one read. */
export async function fetchGame(
  connection: Connection,
  mint: PublicKey
): Promise<GameSummary | null> {
  const program = readProgram(connection);
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), mint.toBuffer()],
    PROGRAM_ID
  );

  const vault = await (program.account as any).vaultState.fetchNullable(vaultPDA);
  if (!vault) return null;

  const [meta, mintInfo, pool] = await Promise.all([
    readTokenMeta(connection, mint),
    getMint(connection, mint).catch(() => null),
    fetchPool(connection, mint).catch(() => null),
  ]);

  const priceSol = poolPriceSol(pool, mintInfo?.decimals ?? 6);
  const supply = mintInfo ? new BN(mintInfo.supply.toString()) : null;
  const marketCapSol =
    priceSol !== null && supply
      ? priceSol * (Number(supply.toString()) / 10 ** (mintInfo?.decimals ?? 6))
      : null;

  return {
    mint: mint.toBase58(),
    vaultState: vaultPDA.toBase58(),
    authority: (vault.authority as PublicKey).toBase58(),
    totalStaked: vault.totalStaked as BN,
    decimals: mintInfo?.decimals ?? 6,
    name: meta.name,
    symbol: meta.symbol,
    supply,
    creatorShare: vault.creatorShare ? new BN(vault.creatorShare.toString()) : null,
    createdAt: vault.createdAt ? Number((vault.createdAt as any).toString()) : 0,
    priceSol,
    marketCapSol,
    change24hPct: null,
    mintAuthorityRevoked: mintInfo ? mintInfo.mintAuthority === null : null,
    freezeAuthorityRevoked: mintInfo ? mintInfo.freezeAuthority === null : null,
    poolSol: pool?.sol ?? null,
    poolTokens: pool?.tokens ?? null,
  };
}

async function fetchPool(connection: Connection, mint: PublicKey) {
  const [swapPoolPDA] = findSwapPoolPDA(mint);
  const info = await connection.getAccountInfo(swapPoolPDA);
  if (!info) return null;
  const rentExempt = await connection.getMinimumBalanceForRentExemption(
    info.data.length
  );
  const sol = Math.max(0, info.lamports - rentExempt) / LAMPORTS_PER_SOL;
  const holdVault = await getAssociatedTokenAddress(mint, swapPoolPDA, true);
  const tokens = await connection
    .getTokenAccountBalance(holdVault)
    .then((r) => new BN(r.value.amount))
    .catch(() => new BN(0));
  return { sol, tokens };
}

/** SOL per token implied by the constant-product pool. */
function poolPriceSol(
  pool: { sol: number; tokens: BN } | null,
  decimals: number
): number | null {
  if (!pool || pool.tokens.isZero()) return null;
  const tokensWhole = Number(pool.tokens.toString()) / 10 ** decimals;
  if (!Number.isFinite(tokensWhole) || tokensWhole === 0) return null;
  return pool.sol / tokensWhole;
}

/**
 * Every game ever launched, newest-looking first.
 *
 * This is a full program-account scan of `VaultState`. Fine at current scale;
 * if this ever gets popular it needs an indexer rather than an RPC sweep, and
 * the UI should say so rather than silently truncating.
 */
export async function fetchAllGames(
  connection: Connection,
  limit = 60
): Promise<{ games: GameSummary[]; truncated: boolean }> {
  const program = readProgram(connection);
  // Filter by the account's exact serialized size so accounts left over from an
  // older program layout (a different VaultState shape) are skipped rather than
  // crashing the whole directory scan on deserialization.
  const idlAccount = (idl as any).accounts.find(
    (a: any) => a.name === "VaultState"
  );
  const size = program.coder.accounts.size(idlAccount);
  const all = await (program.account as any).vaultState.all([{ dataSize: size }]);

  const sorted = [...all].sort((a: any, b: any) => {
    const aStaked = a.account.totalStaked as BN;
    const bStaked = b.account.totalStaked as BN;
    return bStaked.cmp(aStaked);
  });
  const slice = sorted.slice(0, limit);

  // Metadata, mint and pool reads are per-game; batch them rather than
  // serialising. The pool read is what gives each card a price and market cap.
  const games: GameSummary[] = await Promise.all(
    slice.map(async (entry: any) => {
      const mint = entry.account.mint as PublicKey;
      const [meta, mintInfo, pool] = await Promise.all([
        readTokenMeta(connection, mint),
        getMint(connection, mint).catch(() => null),
        fetchPool(connection, mint).catch(() => null),
      ]);
      const decimals = mintInfo?.decimals ?? 6;
      const supply = mintInfo ? new BN(mintInfo.supply.toString()) : null;
      const priceSol = poolPriceSol(pool, decimals);
      const marketCapSol =
        priceSol !== null && supply
          ? priceSol * (Number(supply.toString()) / 10 ** decimals)
          : null;
      return {
        mint: mint.toBase58(),
        vaultState: entry.publicKey.toBase58(),
        authority: (entry.account.authority as PublicKey).toBase58(),
        totalStaked: entry.account.totalStaked as BN,
        decimals,
        name: meta.name,
        symbol: meta.symbol,
        supply,
        creatorShare: entry.account.creatorShare
          ? new BN(entry.account.creatorShare.toString())
          : null,
        createdAt: entry.account.createdAt
          ? Number(entry.account.createdAt.toString())
          : 0,
        priceSol,
        marketCapSol,
        change24hPct: null,
        mintAuthorityRevoked: mintInfo ? mintInfo.mintAuthority === null : null,
        freezeAuthorityRevoked: mintInfo ? mintInfo.freezeAuthority === null : null,
        poolSol: pool?.sol ?? null,
        poolTokens: pool?.tokens ?? null,
      } satisfies GameSummary;
    })
  );

  // Merge 24h price change from the indexer. Best-effort: if the market API or
  // KV is unavailable, the field stays null and the UI hides the delta.
  const market = await fetchMarketStats();
  if (market) {
    for (const g of games) {
      const m = market[g.mint];
      if (m && typeof m.change24hPct === "number") {
        g.change24hPct = m.change24hPct;
      }
    }
  }

  return { games, truncated: sorted.length > limit };
}

/** 24h price change per mint, from the indexer. null when unavailable. */
export async function fetchMarketStats(): Promise<
  Record<string, { change24hPct: number | null }> | null
> {
  try {
    const res = await fetch("/api/market");
    if (!res.ok) return null;
    return (await res.json()) as Record<
      string,
      { change24hPct: number | null }
    >;
  } catch {
    return null;
  }
}

export interface SafetyFlag {
  level: "good" | "warn" | "danger";
  label: string;
  detail: string;
}

/**
 * Anyone can launch here, which means anyone can launch something predatory.
 * The app's job is not to vouch for tokens — it's to show, plainly, the facts
 * that decide whether a stranger's token can rug you.
 */
export function safetyFlags(game: GameSummary): SafetyFlag[] {
  const flags: SafetyFlag[] = [];

  if (game.creatorShare !== null && game.supply && !game.supply.isZero()) {
    const bps = game.creatorShare.muln(10000).div(game.supply).toNumber();
    if (bps <= 500) {
      flags.push({
        level: "good",
        label: "Creator owns ≤5%",
        detail: `The creator was capped at ${(bps / 100).toFixed(2)}% at launch.`,
      });
    } else {
      flags.push({
        level: "danger",
        label: "Creator owns >5%",
        detail: `The creator holds ${(bps / 100).toFixed(2)}% of supply.`,
      });
    }
  }

  if (game.mintAuthorityRevoked === true) {
    flags.push({
      level: "good",
      label: "Supply locked",
      detail: "No more coins can ever be created.",
    });
  } else if (game.mintAuthorityRevoked === false) {
    flags.push({
      level: "danger",
      label: "Supply not locked",
      detail: "The creator can still mint more coins.",
    });
  }

  if (game.freezeAuthorityRevoked === false) {
    flags.push({
      level: "danger",
      label: "Can freeze balances",
      detail: "The creator can freeze your coins.",
    });
  } else if (game.freezeAuthorityRevoked === true) {
    flags.push({
      level: "good",
      label: "Cannot be frozen",
      detail: "Nobody can freeze your coins.",
    });
  }

  flags.push({
    level: "warn",
    label: "Creator adds liquidity",
    detail: "Only the creator can add to the pool. Liquidity can't be withdrawn.",
  });

  return flags;
}
