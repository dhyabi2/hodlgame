import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, BN, Program, EventParser } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, getMint } from "@solana/spl-token";
import idl from "../idl.json";

/**
 * Server-side chain reads for the indexer. This deliberately does NOT import
 * anything from the client bundle — it runs inside Vercel route handlers and
 * cron jobs against the server-only `RPC_URL`.
 */

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? (idl as any).metadata.address
);

export function serverConnection(): Connection {
  const url = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  return new Connection(url, "confirmed");
}

function readProgram(connection: Connection) {
  const provider = new AnchorProvider(
    connection,
    {} as any,
    AnchorProvider.defaultOptions()
  );
  return new Program<any>(idl as any, PROGRAM_ID, provider);
}

async function readPool(connection: Connection, mint: PublicKey) {
  const [swapPoolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap_pool"), mint.toBuffer()],
    PROGRAM_ID
  );
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

function poolPriceSol(
  pool: { sol: number; tokens: BN } | null,
  decimals: number
): number | null {
  if (!pool || pool.tokens.isZero()) return null;
  const tokensWhole = Number(pool.tokens.toString()) / 10 ** decimals;
  if (!Number.isFinite(tokensWhole) || tokensWhole === 0) return null;
  return pool.sol / tokensWhole;
}

export interface TokenStats {
  mint: string;
  decimals: number;
  supply: BN;
  priceSol: number | null;
  marketCapSol: number | null;
}

/** Every token currently live, with its on-chain price and market cap. */
export async function listTokens(
  connection: Connection
): Promise<TokenStats[]> {
  const program = readProgram(connection);
  const idlAccount = (idl as any).accounts.find(
    (a: any) => a.name === "VaultState"
  );
  const size = program.coder.accounts.size(idlAccount);
  const all = await (program.account as any).vaultState.all([{ dataSize: size }]);

  return Promise.all(
    all.map(async (entry: any) => {
      const mint: PublicKey = entry.account.mint;
      const mintInfo = await getMint(connection, mint).catch(() => null);
      const decimals = mintInfo?.decimals ?? 6;
      const supply = mintInfo ? new BN(mintInfo.supply.toString()) : new BN(0);
      const pool = await readPool(connection, mint).catch(() => null);
      const priceSol = poolPriceSol(pool, decimals);
      const marketCapSol =
        priceSol !== null && !supply.isZero()
          ? priceSol * (Number(supply.toString()) / 10 ** decimals)
          : null;
      return { mint: mint.toBase58(), decimals, supply, priceSol, marketCapSol };
    })
  );
}

export interface PricePoint {
  time: number;
  price: number;
}

/**
 * Reconstructs a token's price history by replaying its `SwapEvent`s (each swap
 * carries an execution price). Sorted ascending by time. Works without any
 * indexer — straight from the chain.
 */
export async function getPriceHistory(
  connection: Connection,
  mint: PublicKey,
  decimals: number,
  limit = 100
): Promise<PricePoint[]> {
  const program = readProgram(connection);
  const parser = new EventParser(PROGRAM_ID, program.coder);
  const [swapPoolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap_pool"), mint.toBuffer()],
    PROGRAM_ID
  );

  const sigs = await connection.getSignaturesForAddress(swapPoolPDA, { limit });
  const wanted = sigs.filter((s) => !s.err).map((s) => s.signature);
  if (wanted.length === 0) return [];

  // Fetch each transaction individually — `getTransactions` batches, which the
  // Helius devnet tier rejects.
  const txs = await Promise.all(
    wanted.map((sig) =>
      connection
        .getTransaction(sig, { maxSupportedTransactionVersion: 0 })
        .catch(() => null)
    )
  );

  const points: PricePoint[] = [];
  for (const tx of txs) {
    const logs = tx?.meta?.logMessages;
    if (!logs) continue;
    for (const parsed of parser.parseLogs(logs)) {
      if (parsed.name !== "SwapEvent") continue;
      const data = parsed.data as any;
      const sol = Number(data.solAmount.toString());
      const hold = Number(data.holdAmount.toString());
      const time = Number(data.timestamp.toString());
      if (hold <= 0 || !Number.isFinite(time)) continue;
      points.push({
        time,
        price: sol / LAMPORTS_PER_SOL / (hold / 10 ** decimals),
      });
    }
  }

  points.sort((a, b) => a.time - b.time);
  return points;
}
