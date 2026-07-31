import type { Metadata } from "next";
import { SolanaProviders } from "../components/SolanaProviders";
import "./globals.css";

export const metadata: Metadata = {
  title: "wire — Solana Memecoin Launchpad",
  description: "Wire your token to Solana in one signature.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
