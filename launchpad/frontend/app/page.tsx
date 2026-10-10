'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import WalletConnector from '../components/WalletConnector';
import TokenForm from '../components/TokenForm';

export default function Home() {
  const { connected } = useWallet();

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-12 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <Image src="/wire-logo.png" alt="Wire" width={34} height={27} />
            <div>
              <h1 className="text-xl font-display font-semibold text-white leading-none">wire</h1>
              <p className="text-xs text-[var(--muted)] mt-1">Solana memecoin launchpad</p>
            </div>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/manage-liquidity" className="text-sm text-[var(--muted)] hover:text-white">
              Manage Liquidity
            </Link>
            <WalletConnector />
          </nav>
        </header>

        <section className="text-center mb-12">
          <h2 className="text-4xl font-display font-semibold mb-4">
            Lanzá tu memecoin en minutos
          </h2>
          <p className="text-[var(--muted)] max-w-2xl mx-auto">
            Conectá tu wallet, completá el formulario, y tu token queda listo para tradear en Raydium.
          </p>
        </section>

        {connected ? (
          <TokenForm />
        ) : (
          <div className="glass-card p-12 text-center rounded-2xl max-w-xl mx-auto">
            <h3 className="text-xl font-display font-semibold mb-3">Conectá tu wallet para empezar</h3>
            <p className="text-[var(--muted)] text-sm mb-6">
              Necesitás una wallet de Solana como Phantom o Solflare para crear tu token.
            </p>
            <WalletConnector />
          </div>
        )}

        <section className="grid md:grid-cols-3 gap-6 mt-16">
          <div className="glass-card p-6 rounded-xl">
            <h3 className="font-semibold mb-2">Creación instantánea</h3>
            <p className="text-sm text-[var(--muted)]">
              Tu token se crea en Solana con metadata real on-chain en segundos.
            </p>
          </div>
          <div className="glass-card p-6 rounded-xl">
            <h3 className="font-semibold mb-2">Listado en Raydium</h3>
            <p className="text-sm text-[var(--muted)]">
              Creá el pool de liquidez apenas termines, sin salir del sitio.
            </p>
          </div>
          <div className="glass-card p-6 rounded-xl">
            <h3 className="font-semibold mb-2">Sin fees ocultas</h3>
            <p className="text-sm text-[var(--muted)]">
              Precio fijo por autoridad revocada, nada de sorpresas.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
