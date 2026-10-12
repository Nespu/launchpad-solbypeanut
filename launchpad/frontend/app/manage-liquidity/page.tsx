'use client';

import Image from 'next/image';
import Link from 'next/link';
import WalletConnector from '../../components/WalletConnector';
import ManageLiquidity from '../../components/ManageLiquidity';
import TokenHistory from '../../components/TokenHistory';

export default function ManageLiquidityPage() {
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-12 py-4 border-b border-white/10">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/wire-logo.png" alt="Wire" width={34} height={27} />
            <div>
              <h1 className="text-xl font-display font-semibold text-white leading-none">wire</h1>
              <p className="text-xs text-[var(--muted)] mt-1">Solana memecoin launchpad</p>
            </div>
          </Link>
          <nav className="flex items-center gap-4">
            <Link href="/" className="text-sm text-[var(--muted)] hover:text-white">
              Crear token
            </Link>
            <WalletConnector />
          </nav>
        </header>
        <ManageLiquidity />
        <TokenHistory />
      </div>
    </main>
  );
}
