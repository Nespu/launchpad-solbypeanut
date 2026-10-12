'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import WithdrawLiquidity from './WithdrawLiquidity';

type Pool = {
  mintAddress: string;
  name: string;
  symbol: string;
  imageUrl: string;
  poolAddress: string;
  createdAt: string;
};

export default function ManageLiquidity() {
  const { publicKey } = useWallet();
  const [pools, setPools] = useState<Pool[]>([]);
  const [selectedPool, setSelectedPool] = useState<Pool | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    if (!publicKey) {
      setPools([]);
      setLoading(false);
      setError('');
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setError('');
    fetch(
      (process.env.NEXT_PUBLIC_API_URL || '') +
        '/api/my-pools?userWallet=' +
        encodeURIComponent(publicKey.toBase58())
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'No se pudieron cargar tus pools');
        }
        return data.pools as Pool[];
      })
      .then((data) => {
        if (active) setPools(data);
      })
      .catch((err: any) => {
        if (active) setError(err.message || 'No se pudieron cargar tus pools');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [publicKey]);

  if (selectedPool) {
    return (
      <WithdrawLiquidity
        poolAddress={selectedPool.poolAddress}
        onBack={() => setSelectedPool(null)}
      />
    );
  }

  return (
    <section className="max-w-4xl mx-auto">
      <div className="mb-8">
        <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>
          LIQUIDEZ
        </div>
        <h2 className="font-display text-2xl mb-2">Manage Liquidity</h2>
        <p className="text-sm text-[var(--muted)]">
          Consulta las pools que creaste y gestiona tus retiros.
        </p>
      </div>

      {!publicKey ? (
        <div className="glass-card p-8 text-center rounded-2xl">
          <p className="text-sm text-[var(--muted)]">Conecta tu wallet desde la barra superior para ver tus pools.</p>
        </div>
      ) : loading ? (
        <div className="glass-card p-8 text-center rounded-2xl text-sm text-[var(--muted)]">
          Cargando tus pools...
        </div>
      ) : error ? (
        <div className="glass-card p-6 rounded-2xl text-sm text-red-400">{error}</div>
      ) : pools.length === 0 ? (
        <div className="glass-card p-8 text-center rounded-2xl text-sm text-[var(--muted)]">
          Esta wallet todavía no tiene pools creadas.
        </div>
      ) : (
        <div className="space-y-4">
          {pools.map((pool) => (
            <article key={pool.mintAddress} className="glass-card rounded-2xl p-5">
              <div className="flex flex-col md:flex-row md:items-center gap-4">
                {pool.imageUrl && (
                  <img
                    src={pool.imageUrl}
                    alt={pool.name}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-display font-semibold">
                    <Link href={`/token/${pool.mintAddress}`} className="hover:text-[var(--wire-green)]">
                      {pool.name} ({pool.symbol})
                    </Link>
                  </h3>
                  <p className="text-xs text-[var(--muted)] font-mono break-all mt-1">
                    Pool: {pool.poolAddress}
                  </p>
                </div>
                <Link
                  href={`/token/${pool.mintAddress}`}
                  className="py-2.5 px-4 rounded-lg font-medium text-sm text-center wire-input"
                >
                  Ver detalles
                </Link>
                <button
                  onClick={() => setSelectedPool(pool)}
                  className="py-2.5 px-4 rounded-lg font-medium text-sm"
                  style={{ background: 'var(--wire-violet)', color: '#fff' }}
                >
                  Withdraw Liquidity
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
