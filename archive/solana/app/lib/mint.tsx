"use client";

import { createContext, useContext, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";

/**
 * Which token's game we're currently looking at.
 *
 * The app used to read a single `NEXT_PUBLIC_MINT` at module scope, which
 * hard-wired the whole frontend to one token. The on-chain program was always
 * multi-tenant (every PDA is seeded by mint); only the client assumed
 * otherwise.
 */
interface MintValue {
  mint: PublicKey;
  decimals: number;
  name: string;
  symbol: string;
}

const MintContext = createContext<MintValue | null>(null);

export function MintProvider({
  mint,
  decimals = 6,
  name = "",
  symbol = "TOKEN",
  children,
}: {
  mint: PublicKey;
  decimals?: number;
  name?: string;
  symbol?: string;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ mint, decimals, name, symbol }),
    [mint, decimals, name, symbol]
  );
  return <MintContext.Provider value={value}>{children}</MintContext.Provider>;
}

export function useMint(): MintValue {
  const ctx = useContext(MintContext);
  if (!ctx) throw new Error("useMint must be used within MintProvider");
  return ctx;
}

/** Null outside a game context — lets shared chrome render on the landing page. */
export function useOptionalMint(): MintValue | null {
  return useContext(MintContext);
}

/** The original launch, if configured. Featured on the landing page. */
export const FEATURED_MINT: PublicKey | null = (() => {
  const raw = process.env.NEXT_PUBLIC_MINT;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
})();
