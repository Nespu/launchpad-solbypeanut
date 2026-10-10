import type { Metadata } from "next";
import Link from "next/link";
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
        <SolanaProviders>
          {children}
          <footer className="border-t border-white/10 px-4 py-6">
            <div className="max-w-4xl mx-auto flex flex-col gap-3 text-xs text-[var(--muted)] md:flex-row md:items-center md:justify-between">
              <p>Los activos digitales son riesgosos y pueden perder todo su valor. Revisá cada operación antes de firmar. Wire no brinda asesoramiento financiero.</p>
              <Link href="/seguridad" className="shrink-0 hover:text-white">Seguridad y riesgos</Link>
            </div>
          </footer>
        </SolanaProviders>
      </body>
    </html>
  );
}
