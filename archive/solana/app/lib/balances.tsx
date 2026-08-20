"use client";

import { createContext, useContext, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { usePoll, type PollStatus } from "./usePoll";
import { useMint } from "./mint";

interface Balances {
  /** The game token, in base units, or null while unknown. */
  hold: BN | null;
  /** SOL in lamports, or null while unknown. */
  lamports: BN | null;
  sol: number | null;
  status: PollStatus;
  refetch: () => void;
}

const BalancesContext = createContext<Balances | null>(null);

/**
 * One poll for both balances, shared by the header, the stake panel and the
 * swap panel. Previously the HOLD balance was fetched in `page.tsx` purely to
 * render it in the footer, and the SOL balance was never fetched at all — so a
 * swap could be submitted with no idea whether it was affordable.
 */
export function BalancesProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { mint } = useMint();
  const owner = wallet.publicKey;

  const { data, status, refetch } = usePoll(
    async () => {
      if (!owner) return { hold: new BN(0), lamports: new BN(0) };
      const [lamports, hold] = await Promise.all([
        connection.getBalance(owner).then((v) => new BN(v)),
        getAssociatedTokenAddress(mint, owner)
          .then((ata) => getAccount(connection, ata))
          .then((acc) => new BN(acc.amount.toString()))
          // No ATA yet is a real, known zero — not a failed read.
          .catch(() => new BN(0)),
      ]);
      return { hold, lamports };
    },
    { intervalMs: 15000, enabled: !!owner, staggerMs: 0 },
    [connection, owner?.toBase58(), mint.toBase58()]
  );

  const value = useMemo<Balances>(
    () => ({
      hold: data?.hold ?? null,
      lamports: data?.lamports ?? null,
      sol: data ? data.lamports.toNumber() / LAMPORTS_PER_SOL : null,
      status,
      refetch,
    }),
    [data, status, refetch]
  );

  return (
    <BalancesContext.Provider value={value}>{children}</BalancesContext.Provider>
  );
}

const EMPTY_BALANCES: Balances = {
  hold: null,
  lamports: null,
  sol: null,
  status: "loading",
  refetch: () => {},
};

/**
 * Returns empties outside a provider rather than throwing, so the header can
 * render on the landing page where no particular token is in scope.
 */
export function useBalances(): Balances {
  return useContext(BalancesContext) ?? EMPTY_BALANCES;
}

/** Leave this much SOL behind when a user taps MAX, so fees still clear. */
export const SOL_FEE_BUFFER_LAMPORTS = new BN(0.01 * LAMPORTS_PER_SOL);
