"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  ConnectionProvider as AdapterConnectionProvider,
  WalletProvider as AdapterWalletProvider,
} from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletIdentityProvider } from "./WalletIdentityProvider";
import LocalizedWalletModalProvider from "./LocalizedWalletModalProvider";
import { DIRECT_PHANTOM_ADAPTER_NAME } from "../lib/walletAdapterNames";

require("@solana/wallet-adapter-react-ui/styles.css");

const ConnectionProvider = AdapterConnectionProvider as unknown as React.ComponentType<
  React.PropsWithChildren<{ endpoint: string }>
>;
const WalletProvider = AdapterWalletProvider as unknown as React.ComponentType<
  React.PropsWithChildren<{
    wallets: Adapter[];
    autoConnect?: boolean;
    onError?: (error: Error, adapter?: Adapter) => void;
  }>
>;

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_RPC_ENDPOINT || "https://api.devnet.solana.com";
  const [connectionError, setConnectionError] = useState<{ walletName: string | null } | null>(null);
  // WalletProvider prefers same-named Wallet Standard adapters. Keep the direct
  // Phantom adapter distinct so account selection follows Phantom's active provider key.
  const wallets = useMemo(() => {
    const phantom = new PhantomWalletAdapter();
    phantom.name = DIRECT_PHANTOM_ADAPTER_NAME as typeof phantom.name;
    return [phantom, new SolflareWalletAdapter()];
  }, []);
  const handleWalletError = useCallback((_error: Error, adapter?: Adapter) => {
    setConnectionError({ walletName: adapter?.name ?? null });
  }, []);
  const clearConnectionError = useCallback(() => setConnectionError(null), []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false} onError={handleWalletError}>
        <LocalizedWalletModalProvider
          connectionError={connectionError}
          clearConnectionError={clearConnectionError}
        >
          <WalletIdentityProvider>{children}</WalletIdentityProvider>
        </LocalizedWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
