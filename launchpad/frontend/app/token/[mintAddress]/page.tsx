'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import WalletConnector from '../../../components/WalletConnector';

type TokenDetails = {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string | null;
  imageUrl: string;
  totalSupply: string;
  liquiditySol: number;
  creatorWallet: string;
  createdAt: string;
  txHash: string;
  poolAddress: string | null;
  status: string;
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completado',
  processing: 'Procesando',
  pending: 'Pendiente',
  failed: 'Fallido',
};

const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

const explorerAddress = (address: string) =>
  `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;

export default function TokenDetailsPage() {
  const params = useParams<{ mintAddress: string }>();
  const mintAddress = params.mintAddress;
  const [token, setToken] = useState<TokenDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/token/${encodeURIComponent(mintAddress)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'No se pudieron cargar los detalles del token.');
        }
        return data.token as TokenDetails;
      })
      .then((data) => {
        if (active) setToken(data);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'No se pudieron cargar los detalles del token.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [mintAddress]);

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
            <Link href="/manage-liquidity" className="text-sm text-[var(--muted)] hover:text-white">
              Manage Liquidity
            </Link>
            <WalletConnector />
          </nav>
        </header>

        <section className="max-w-2xl mx-auto">
          <Link href="/manage-liquidity" className="text-sm text-[var(--muted)] hover:text-white">
            ← Volver a Manage Liquidity
          </Link>

          {loading ? (
            <div className="glass-card mt-6 rounded-2xl p-8 text-sm text-[var(--muted)]">Cargando token...</div>
          ) : error ? (
            <div className="glass-card mt-6 rounded-2xl p-8 text-sm text-red-400">{error}</div>
          ) : token ? (
            <article className="glass-card mt-6 rounded-2xl p-6 md:p-8">
              <div className="flex items-center gap-4 mb-6">
                {token.imageUrl ? (
                  <img src={token.imageUrl} alt={token.name} className="h-16 w-16 rounded-full object-cover" />
                ) : null}
                <div className="min-w-0">
                  <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>TOKEN · DEVNET</div>
                  <h2 className="font-display text-2xl font-semibold break-words">{token.name} ({token.symbol})</h2>
                </div>
              </div>

              {token.description ? (
                <p className="text-sm text-[var(--muted)] whitespace-pre-wrap mb-6">{token.description}</p>
              ) : null}

              <dl className="space-y-3 text-sm">
                <div className="flex flex-col gap-1 border-b border-white/10 pb-3">
                  <dt className="text-[var(--muted)]">Mint</dt>
                  <dd className="font-mono break-all">{token.mintAddress}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-[var(--muted)]">Supply</dt>
                  <dd className="font-mono text-right break-all">{token.totalSupply} {token.symbol}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-[var(--muted)]">SOL configurados al crear el token</dt>
                  <dd className="font-mono text-right">{token.liquiditySol} SOL</dd>
                </div>
                <div className="flex flex-col gap-1 border-b border-white/10 pb-3">
                  <dt className="text-[var(--muted)]">Creador</dt>
                  <dd className="font-mono break-all">{token.creatorWallet}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-[var(--muted)]">Creado</dt>
                  <dd className="text-right">{new Date(token.createdAt).toLocaleString()}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-[var(--muted)]">Estado</dt>
                  <dd>{statusLabel(token.status)}</dd>
                </div>
                {token.poolAddress && token.poolAddress !== 'pending' ? (
                  <div className="flex flex-col gap-1">
                    <dt className="text-[var(--muted)]">Pool</dt>
                    <dd className="font-mono break-all">{token.poolAddress}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="grid gap-3 sm:grid-cols-2 mt-7">
                <a href={explorerAddress(token.mintAddress)} target="_blank" rel="noreferrer" className="wire-input rounded-lg p-3 text-center text-sm hover:text-white">
                  Ver token en Explorer (Devnet)
                </a>
                <a href={`https://explorer.solana.com/tx/${encodeURIComponent(token.txHash)}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-input rounded-lg p-3 text-center text-sm hover:text-white">
                  Ver creación en Explorer
                </a>
                {token.poolAddress && token.poolAddress !== 'pending' ? (
                  <a href={explorerAddress(token.poolAddress)} target="_blank" rel="noreferrer" className="wire-input rounded-lg p-3 text-center text-sm hover:text-white sm:col-span-2">
                    Ver pool en Explorer (Devnet)
                  </a>
                ) : null}
              </div>
            </article>
          ) : null}
        </section>
      </div>
    </main>
  );
}
