"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider as AdapterConnectionProvider,
  WalletProvider as AdapterWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletIdentityProvider } from "./WalletIdentityProvider";

require("@solana/wallet-adapter-react-ui/styles.css");

const ConnectionProvider = AdapterConnectionProvider as unknown as React.ComponentType<
  React.PropsWithChildren<{ endpoint: string }>
>;
const WalletProvider = AdapterWalletProvider as unknown as React.ComponentType<
  React.PropsWithChildren<{ wallets: Adapter[]; autoConnect?: boolean }>
>;

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_RPC_ENDPOINT || "https://api.devnet.solana.com";
  // WalletProvider also discovers wallets registered through Wallet Standard, including Backpack.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletIdentityProvider>{children}</WalletIdentityProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
