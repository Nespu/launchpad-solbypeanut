'use client';

import { useEffect, useState } from 'react';
import { WalletModalButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletIdentity } from './WalletIdentityProvider';

function shortenAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatBalance(balance: number | null) {
  if (balance === null) return '—';
  return new Intl.NumberFormat('es-MX', { minimumFractionDigits: 3, maximumFractionDigits: 4 }).format(balance);
}

export default function WalletAccountPanel() {
  const { publicKey } = useWallet();
  const {
    identifiedWallet,
    walletProviderName,
    balanceSol,
    balanceUpdatedAt,
    balanceLoading,
    loading,
    error,
    identifyWallet,
    clearWalletIdentity,
  } = useWalletIdentity();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const address = publicKey?.toBase58() ?? null;
  const identified = Boolean(address && identifiedWallet === address);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const handleIdentity = async () => {
    setActionError('');
    try {
      if (identified) await clearWalletIdentity();
      else await identifyWallet();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : error || 'No se pudo completar la acción.');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-3 rounded-full border border-white/10 bg-[#17191d] px-4 py-3 shadow-2xl transition hover:border-[var(--wire-green)]/60 hover:bg-[#202329]"
        aria-label="Abrir panel de wallet"
      >
        <span className={`h-2.5 w-2.5 rounded-full ${address ? 'bg-[var(--wire-green)] shadow-[0_0_12px_var(--wire-green)]' : 'bg-gray-500'}`} />
        <span className="text-left">
          <span className="block text-xs font-semibold">{address ? `${walletProviderName || 'Wallet'} · ${shortenAddress(address)}` : 'Wallet'}</span>
          <span className="block font-mono text-[10px] text-[var(--muted)]">{address ? `${formatBalance(balanceSol)} SOL` : 'Conectar o identificar'}</span>
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-panel-title"
            className="glass-card w-full max-w-md rounded-2xl bg-[#0c0e11] p-6 shadow-[0_24px_100px_rgba(0,0,0,0.65)]"
          >
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--wire-green)]">Tu cuenta</p>
                <h2 id="wallet-panel-title" className="text-xl font-semibold">Wallet</h2>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-xl text-[var(--muted)] hover:bg-white/5 hover:text-white" aria-label="Cerrar">×</button>
            </div>

            {address ? (
              <>
                <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{walletProviderName || 'Wallet Solana'}</p>
                      <p className="mt-1 font-mono text-xs text-[var(--muted)]">{shortenAddress(address)}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${identified ? 'bg-emerald-400/10 text-emerald-300' : 'bg-white/5 text-[var(--muted)]'}`}>
                      {identified ? 'Identificada' : 'Conectada'}
                    </span>
                  </div>
                  <div className="rounded-lg border border-white/5 bg-black/20 p-4">
                    <p className="text-xs text-[var(--muted)]">Saldo de la wallet</p>
                    <p className="mt-1 font-mono text-3xl font-semibold tracking-tight">{formatBalance(balanceSol)} <span className="text-base text-[var(--wire-green)]">SOL</span></p>
                    <p className="mt-2 text-[10px] text-[var(--muted)]">
                      {balanceLoading && balanceSol === null ? 'Consultando saldo…' : balanceUpdatedAt ? `Actualizado ${new Date(balanceUpdatedAt).toLocaleTimeString()}` : 'Saldo pendiente de consulta'}
                      {' · Devnet'}
                    </p>
                  </div>
                </div>

                <p className="mb-4 text-xs leading-5 text-[var(--muted)]">
                  La identificación confirma que controlas esta dirección con una firma gratuita. El nombre mostrado corresponde al proveedor de wallet y a tu dirección pública.
                </p>
                <button
                  type="button"
                  onClick={handleIdentity}
                  disabled={loading}
                  className="w-full rounded-lg bg-[var(--wire-green)] px-4 py-3 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                >
                  {loading ? 'Esperando firma…' : identified ? 'Cerrar sesión de wallet' : 'Iniciar sesión con firma'}
                </button>
                <button type="button" onClick={() => setOpen(false)} className="mt-3 w-full rounded-lg border border-white/10 px-4 py-2.5 text-sm text-[var(--muted)] hover:text-white">Listo</button>
              </>
            ) : (
              <>
                <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-[var(--muted)]">
                  Conecta una wallet Solana para ver su saldo Devnet y, si quieres, identificarte firmando un mensaje gratuito.
                </div>
                <WalletModalButton className="!h-11 !w-full !rounded-lg !bg-purple-600 !text-sm hover:!bg-purple-700">Conectar wallet</WalletModalButton>
              </>
            )}

            {(actionError || error) && <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{actionError || error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
