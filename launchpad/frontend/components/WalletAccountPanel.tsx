'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { WalletModalButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePathname } from 'next/navigation';
import { ChevronDown, Wallet, X } from 'lucide-react';
import { useWalletIdentity } from './WalletIdentityProvider';
import { notifyToast, userFacingError } from './toastEvents';
import { useWireLocale } from './LocaleProvider';

function shortenAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatBalance(balance: number | null, locale: 'es' | 'en') {
  if (balance === null) return '—';
  return new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 }).format(balance);
}

function formatHeaderBalance(balance: number | null, locale: 'es' | 'en') {
  if (balance === null) return '—';
  const precision = balance > 0 && balance < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: precision,
  }).format(balance);
}

export default function WalletAccountPanel() {
  const { locale, t } = useWireLocale();
  const { publicKey, wallet, disconnect } = useWallet();
  const pathname = usePathname();
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
  const [disconnecting, setDisconnecting] = useState(false);
  const walletTriggerRef = useRef<HTMLButtonElement>(null);
  const walletDialogRef = useRef<HTMLElement>(null);
  const [introComplete, setIntroComplete] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const address = publicKey?.toBase58() ?? null;
  const identified = Boolean(address && identifiedWallet === address);
  const provider = walletProviderName?.toLowerCase() ?? '';
  const providerTheme = provider.includes('phantom')
    ? 'phantom'
    : provider.includes('backpack')
      ? 'backpack'
      : provider.includes('solflare')
        ? 'solflare'
        : provider.includes('coinbase')
          ? 'coinbase'
          : provider.includes('trust')
            ? 'trust'
            : 'wire';

  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    const updateIntroState = () => setIntroComplete(window.localStorage.getItem('wire:intro-complete:v1') === 'true');
    updateIntroState();
    window.addEventListener('wire:intro-state', updateIntroState);
    return () => window.removeEventListener('wire:intro-state', updateIntroState);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = walletDialogRef.current;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const first = dialog?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialog)?.focus();
    };
    focusFirst();

    const manageDialogKeys = (event: KeyboardEvent) => {
      // The wallet adapter opens its own modal from the connect button. Let its
      // dialog own keyboard focus while it is present.
      if (event.target instanceof Element && event.target.closest('.wallet-adapter-modal')) return;
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', manageDialogKeys);
    return () => {
      window.removeEventListener('keydown', manageDialogKeys);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else walletTriggerRef.current?.focus();
    };
  }, [open]);

  if (pathname === '/' && !introComplete) return null;

  const handleIdentity = async () => {
    try {
      if (identified) await clearWalletIdentity();
      else await identifyWallet();
    } catch (caught) {
      notifyToast({
        title: t(identified ? 'No se pudo cerrar la sesión' : 'No se pudo identificar la wallet'),
        message: userFacingError(caught, t(error || 'No se pudo completar la acción.'), t),
      });
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    let identityCleanupError: unknown = null;
    try {
      if (identified) {
        try {
          await clearWalletIdentity();
        } catch (caught) {
          identityCleanupError = caught;
        }
      }

      await disconnect();
      setOpen(false);
      notifyToast({
        title: t('Wallet desconectada'),
        message: identityCleanupError
          ? userFacingError(identityCleanupError, t('La wallet se desconectó, pero Wire no pudo cerrar la sesión identificada.'), t)
          : t('La wallet se desconectó de Wire. Puedes conectar otra cuenta.'),
      });
    } catch (caught) {
      notifyToast({
        title: t('No se pudo desconectar la wallet'),
        message: userFacingError(caught, t(error || 'No se pudo completar la acción.'), t),
      });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <div className="wire-wallet-control flex min-w-0 items-center">
      <button
        ref={walletTriggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="wire-wallet-top"
        data-wallet-provider={hydrated ? providerTheme : 'wire'}
        aria-label={address ? t('Abrir wallet {address}, saldo {balance} SOL', { address: shortenAddress(address), balance: formatHeaderBalance(balanceSol, locale) }) : t('Conectar o identificar wallet')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={`wire-wallet-top-icon ${address ? 'is-connected' : ''}`} aria-hidden="true">
          {address && wallet?.adapter.icon ? (
            // Wallet adapters expose their own icon as a data or remote URL.
            <Image className="wire-wallet-brand-icon" src={wallet.adapter.icon} alt="" width={21} height={21} unoptimized />
          ) : (
            <Wallet size={17} strokeWidth={1.8} />
          )}
        </span>
        <span className="wire-wallet-top-copy">
          <span className="wire-wallet-top-label">{address ? walletProviderName || t('Wallet conectada') : t('Tu wallet')}</span>
          <span className="wire-wallet-top-address">{address ? shortenAddress(address) : t('Conectar o identificar')}</span>
        </span>
        <span className="wire-wallet-top-balance">
          <span>{address ? balanceLoading && balanceSol === null ? t('Cargando') : formatHeaderBalance(balanceSol, locale) : t('Conectar')}</span>
          {address && <small>SOL</small>}
        </span>
        <ChevronDown className="wire-wallet-top-chevron" size={15} aria-hidden="true" />
      </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <section
            ref={walletDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-panel-title"
            tabIndex={-1}
            className="glass-card wire-wallet-dialog wire-dialog-enter w-full max-w-md rounded-2xl p-6"
          >
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--wire-green)]">{t('Tu cuenta')}</p>
                <h2 id="wallet-panel-title" className="text-xl font-semibold">Wallet</h2>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="wire-button wire-button-quiet h-10 w-10 p-0" aria-label={t('Cerrar panel de wallet')}><X size={17} aria-hidden="true" /></button>
            </div>

            {address ? (
              <>
                <div className="wire-wallet-card mb-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{walletProviderName || t('Wallet Solana')}</p>
                      <p className="mt-1 font-mono text-xs text-[var(--muted)]">{shortenAddress(address)}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${identified ? 'bg-emerald-400/10 text-emerald-300' : 'bg-white/5 text-[var(--muted)]'}`}>
                      {identified ? t('Identificada') : t('Conectada')}
                    </span>
                  </div>
                  <div className="wire-wallet-balance">
                    <p className="text-xs text-[var(--muted)]">{t('Saldo de la wallet')}</p>
                    <p className="mt-1 font-mono text-3xl font-semibold tracking-tight">{formatBalance(balanceSol, locale)} <span className="text-base text-[var(--wire-green)]">SOL</span></p>
                    <p className="mt-2 text-[10px] text-[var(--muted)]">
                      {balanceLoading && balanceSol === null ? t('Consultando saldo…') : balanceUpdatedAt ? t('Actualizado {time}', { time: new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { timeStyle: 'short' }).format(new Date(balanceUpdatedAt)) }) : t('Saldo pendiente de consulta')}
                      {' · Devnet'}
                    </p>
                  </div>
                </div>

                <p className="mb-4 text-xs leading-5 text-[var(--muted)]">
                  {t('Wire usa la cuenta activa de Phantom. Para usar otra, cambia de cuenta en la extensión y reconecta Wire.')}
                </p>

                <p className="mb-4 text-xs leading-5 text-[var(--muted)]">
                  {t('La identificación confirma que controlas esta dirección con una firma gratuita. El nombre mostrado corresponde al proveedor de wallet y a tu dirección pública.')}
                </p>
                <button
                  type="button"
                  onClick={handleIdentity}
                  disabled={loading || disconnecting}
                  className="wire-button wire-button-primary w-full px-4 py-3"
                >
                  {loading ? t('Esperando firma…') : identified ? t('Cerrar sesión de wallet') : t('Iniciar sesión con firma')}
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={loading || disconnecting}
                  className="wire-button wire-button-secondary mt-3 w-full px-4 py-3"
                >
                  {disconnecting ? t('Desconectando wallet…') : t('Desconectar wallet de Wire')}
                </button>
                <button type="button" onClick={() => setOpen(false)} disabled={disconnecting} className="wire-button wire-button-secondary mt-3 w-full">{t('Listo')}</button>
              </>
            ) : (
              <>
                <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-[var(--muted)]">
                  {t('Conecta una wallet Solana para ver su saldo Devnet y, si quieres, identificarte firmando un mensaje gratuito.')}
                </div>
                <WalletModalButton className="!h-11 !w-full !rounded-lg !bg-[var(--wire-green)] !text-sm !font-semibold !text-[#0b140a] hover:!bg-[#91ff76]">{t('Conectar wallet')}</WalletModalButton>
              </>
            )}

          </section>
        </div>
      )}
    </>
  );
}
