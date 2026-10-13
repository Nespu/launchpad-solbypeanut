'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletIdentity } from './WalletIdentityProvider';

type WalletTokenActivity = {
  mintAddress: string;
  name: string;
  symbol: string;
  imageUrl: string;
  poolAddress: string | null;
  status: string;
  createdAt: string;
  txHash: string;
};

type WalletWithdrawalActivity = {
  id: string;
  poolAddress: string;
  lpTokenAmount: number;
  userAmount: number;
  platformFee: number;
  status: string;
  txHash: string | null;
  createdAt: string;
};

type WalletHistory = { tokens: WalletTokenActivity[]; withdrawals: WalletWithdrawalActivity[] };

const STATUS_LABELS: Record<string, string> = {
  created: 'Token creado',
  completed: 'Completado',
  processing: 'Procesando',
  pending: 'Pendiente',
  failed: 'Fallido',
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function explorerAddress(address: string) {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}

function explorerTransaction(signature: string) {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function formatSol(amount: number) {
  return new Intl.NumberFormat('es-MX', { minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(amount);
}

export default function TokenHistory() {
  const { publicKey } = useWallet();
  const { identifiedWallet } = useWalletIdentity();
  const [history, setHistory] = useState<WalletHistory>({ tokens: [], withdrawals: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const identified = Boolean(publicKey && identifiedWallet === publicKey.toBase58());

  useEffect(() => {
    const refresh = () => setRefreshVersion((version) => version + 1);
    window.addEventListener('wire:wallet-history-updated', refresh);
    return () => window.removeEventListener('wire:wallet-history-updated', refresh);
  }, []);

  useEffect(() => {
    let active = true;
    if (!identified) {
      setHistory({ tokens: [], withdrawals: [] });
      setError('');
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError('');
    fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/wallet-history`, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo cargar el historial.');
        return { tokens: data.tokens as WalletTokenActivity[], withdrawals: data.withdrawals as WalletWithdrawalActivity[] };
      })
      .then((data) => { if (active) setHistory(data); })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'No se pudo cargar el historial.');
      })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [identified, identifiedWallet, refreshVersion]);

  const activity = useMemo(() => [
    ...history.tokens.map((token) => ({ type: 'token' as const, date: token.createdAt, token })),
    ...history.withdrawals.map((withdrawal) => ({ type: 'withdrawal' as const, date: withdrawal.createdAt, withdrawal })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), [history]);

  return (
    <section className="max-w-4xl mx-auto mt-10">
      <div className="mb-5">
        <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>HISTORIAL</div>
        <h2 className="font-display text-xl mb-2">Actividad de wallet</h2>
        <p className="text-sm text-[var(--muted)]">Tokens registrados, pools asociadas y retiros de liquidez en Devnet.</p>
      </div>

      {!publicKey ? (
        <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Conecta tu wallet para consultar la actividad.</div>
      ) : !identified ? (
        <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Abre el panel Wallet e identifícate con una firma gratuita para ver tu historial.</div>
      ) : loading ? (
        <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Cargando actividad...</div>
      ) : error ? (
        <div role="alert" className="glass-card p-6 rounded-2xl text-sm text-red-400">{error}</div>
      ) : activity.length === 0 ? (
        <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Todavía no hay actividad registrada para esta wallet.</div>
      ) : (
        <div className="space-y-4">
          {activity.map((item) => item.type === 'token' ? (
            <article key={`token-${item.token.mintAddress}`} className="glass-card rounded-2xl p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                {item.token.imageUrl ? <img src={item.token.imageUrl} alt={item.token.name} className="h-12 w-12 rounded-full object-cover" /> : null}
                <div className="min-w-0 flex-1">
                  <h3 className="font-display font-semibold">{item.token.name} ({item.token.symbol})</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Token creado · {item.token.poolAddress && item.token.poolAddress !== 'pending' ? 'Pool asociada' : 'Sin pool'} · {statusLabel(item.token.status)} · {new Date(item.date).toLocaleString()}
                  </p>
                  <p className="mt-2 break-all font-mono text-[10px] text-[var(--muted)]">Mint: {item.token.mintAddress}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/token/${item.token.mintAddress}`} className="wire-input rounded-lg px-3 py-2 text-center text-xs">Detalles</Link>
                  <a href={explorerAddress(item.token.mintAddress)} target="_blank" rel="noreferrer" className="wire-input rounded-lg px-3 py-2 text-center text-xs">Explorer</a>
                  {item.token.txHash && <a href={explorerTransaction(item.token.txHash)} target="_blank" rel="noreferrer" className="wire-input rounded-lg px-3 py-2 text-center text-xs">Tx token</a>}
                  {item.token.poolAddress && item.token.poolAddress !== 'pending' && <a href={explorerAddress(item.token.poolAddress)} target="_blank" rel="noreferrer" className="wire-input rounded-lg px-3 py-2 text-center text-xs">Pool</a>}
                </div>
              </div>
            </article>
          ) : (
            <article key={`withdrawal-${item.withdrawal.id}`} className="glass-card rounded-2xl p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">Retiro de liquidez</h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[var(--muted)]">{statusLabel(item.withdrawal.status)}</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{new Date(item.date).toLocaleString()}</p>
                  <p className="mt-2 font-mono text-xs">
                    {item.withdrawal.status === 'completed' ? 'Recibiste' : 'Estimación neta al solicitar'} {formatSol(item.withdrawal.userAmount)} SOL
                    <span className="text-[var(--muted)]"> · Fee {formatSol(item.withdrawal.platformFee)} SOL</span>
                  </p>
                  <p className="mt-2 break-all font-mono text-[10px] text-[var(--muted)]">Pool: {item.withdrawal.poolAddress}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={explorerAddress(item.withdrawal.poolAddress)} target="_blank" rel="noreferrer" className="wire-input rounded-lg px-3 py-2 text-center text-xs">Pool</a>
                  {item.withdrawal.txHash && <a href={explorerTransaction(item.withdrawal.txHash)} target="_blank" rel="noreferrer" className="wire-input rounded-lg px-3 py-2 text-center text-xs">Transacción</a>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
