"use client";

import { createContext, useContext, useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, findStakeAccountPDA, findVaultStatePDA } from "./program";
import { getHoldingScore } from "./tiers";
import { usePoll, type PollStatus } from "./usePoll";
import { useMint } from "./mint";
import idl from "./idl.json";

export interface Staker {
  owner: string;
  pubkey: string;
  amount: BN;
  points: BN;
  /** Time-weighted average hold, in seconds — the tier metric. */
  avgHoldSeconds: number;
}

interface StakersValue {
  stakers: Staker[] | null;
  status: PollStatus;
  refetch: () => void;
}

const StakersContext = createContext<StakersValue | null>(null);

/**
 * `stakeAccount.all()` is a full program-account scan — the most expensive read
 * in the app. It used to run twice over: every 15s for the leaderboard and
 * every 20s for the streak percentile. One subscription now serves both.
 *
 * Now that the app is multi-tenant, the scan also returns stake accounts from
 * *every other token's* game. `StakeAccount` stores only `owner` — there's no
 * vault field to filter on and no `memcmp` that would work server-side — so
 * membership is proved by re-deriving each account's PDA from this game's
 * vault and checking it matches. Wrong-game accounts fail that check.
 */
export function StakersProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const { mint } = useMint();

  const { data, status, refetch } = usePoll<Staker[]>(
    async () => {
      const provider = new AnchorProvider(
        connection,
        {} as any,
        AnchorProvider.defaultOptions()
      );
      const program = new Program<any>(idl as any, PROGRAM_ID, provider);
      const [vaultPDA] = findVaultStatePDA(mint);
      const accounts = await (program.account as any).stakeAccount.all();

      return accounts
        .filter((entry: any) => {
          const owner = entry.account.owner as PublicKey;
          const [expected] = findStakeAccountPDA(vaultPDA, owner);
          return expected.equals(entry.publicKey);
        })
        .map((entry: any) => {
          const amount = entry.account.amount as BN;
          const points = entry.account.points as BN;
          return {
            owner: (entry.account.owner as PublicKey).toBase58(),
            pubkey: entry.publicKey.toBase58(),
            amount,
            points,
            avgHoldSeconds: getHoldingScore(points, amount).avgHoldSeconds,
          } satisfies Staker;
        })
        .filter((s: Staker) => s.amount.gtn(0));
    },
    { intervalMs: 30000, staggerMs: 1200 },
    [connection, mint.toBase58()]
  );

  const value = useMemo<StakersValue>(
    () => ({ stakers: data, status, refetch }),
    [data, status, refetch]
  );

  return (
    <StakersContext.Provider value={value}>{children}</StakersContext.Provider>
  );
}

export function useStakers(): StakersValue {
  const ctx = useContext(StakersContext);
  if (!ctx) throw new Error("useStakers must be used within StakersProvider");
  return ctx;
}
