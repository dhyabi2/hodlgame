"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ??
  "devnet") as WalletAdapterNetwork;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  // HTTP goes through our own origin, so the upstream API key is never shipped
  // to the browser (see app/api/rpc/route.ts). It used to be inlined into the
  // bundle via NEXT_PUBLIC_RPC_URL.
  //
  // `Connection` demands an absolute URL and there's no origin during
  // prerender, so SSR falls back to the public cluster — nothing on the server
  // actually reads chain state, it just has to construct without throwing.
  const endpoint = useMemo(
    () =>
      typeof window === "undefined"
        ? clusterApiUrl(NETWORK)
        : `${window.location.origin}/api/rpc`,
    []
  );

  // WebSockets can't go through a Next route handler, and the live feed needs
  // one for `program.addEventListener`. Point NEXT_PUBLIC_WS_URL at a keyless
  // or domain-restricted socket; the cluster's public WS is the fallback and is
  // adequate for read-only event subscriptions.
  const wsEndpoint = useMemo(() => {
    const explicit = process.env.NEXT_PUBLIC_WS_URL;
    if (explicit) return explicit;
    return clusterApiUrl(NETWORK).replace(/^https:/, "wss:");
  }, []);

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider
      endpoint={endpoint}
      config={{ commitment: "confirmed", wsEndpoint }}
    >
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
