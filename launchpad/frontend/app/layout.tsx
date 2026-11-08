import type { Metadata } from "next";
import { SolanaProviders } from "../components/SolanaProviders";
import ToastViewport from "../components/ToastViewport";
import AppFooter from "../components/AppFooter";
import { LocaleProvider } from "../components/LocaleProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "wire — Solana Memecoin Launchpad",
  description: "Wire your token to Solana in one signature.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <LocaleProvider>
          <SolanaProviders>
            {children}
            <ToastViewport />
            <AppFooter />
          </SolanaProviders>
        </LocaleProvider>
      </body>
    </html>
  );
}
