'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletModalContext } from '@solana/wallet-adapter-react-ui';
import { useWireLocale } from './LocaleProvider';
import { DIRECT_PHANTOM_ADAPTER_NAME, walletDisplayName } from '../lib/walletAdapterNames';

type WalletConnectionError = { walletName: string | null } | null;
type PhantomInjectedProvider = {
  isConnected?: boolean;
  disconnect?: () => Promise<void>;
};
type WindowWithPhantom = Window & {
  phantom?: { solana?: PhantomInjectedProvider };
};

function LocalizedWalletDialog({
  close,
  connectionError,
  clearConnectionError,
}: {
  close: () => void;
  connectionError: WalletConnectionError;
  clearConnectionError: () => void;
}) {
  const { wallets, wallet, select, connect, connected, connecting } = useWallet();
  const { t } = useWireLocale();
  const [expanded, setExpanded] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [unavailableSelection, setUnavailableSelection] = useState(false);
  const [preparingConnection, setPreparingConnection] = useState(false);
  const [preparationError, setPreparationError] = useState(false);
  const [readyToConnect, setReadyToConnect] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const connectionAttemptRef = useRef<string | null>(null);

  const [listedWallets, collapsedWallets, selectableWallets] = useMemo(() => {
    const compatibleWallets = wallets.filter((wallet) => wallet.readyState !== WalletReadyState.Unsupported);
    const directPhantomInstalled = compatibleWallets.some(
      (wallet) => wallet.adapter.name === DIRECT_PHANTOM_ADAPTER_NAME
        && wallet.readyState === WalletReadyState.Installed,
    );
    const available = compatibleWallets.filter((wallet) => {
      const standard = (wallet.adapter as typeof wallet.adapter & { standard?: boolean }).standard;
      const duplicatePhantom = directPhantomInstalled && wallet.adapter.name === 'Phantom' && standard === true;
      return !duplicatePhantom;
    });
    const installed = available.filter((wallet) => wallet.readyState === WalletReadyState.Installed);
    const notInstalled = available.filter((wallet) => wallet.readyState !== WalletReadyState.Installed);
    return installed.length
      ? [installed, notInstalled, available]
      : [notInstalled, [], available];
  }, [wallets]);

  const selectWallet = (walletName: Parameters<typeof select>[0]) => {
    clearConnectionError();
    connectionAttemptRef.current = null;
    setSelectedWallet(walletName);
    setPreparationError(false);
    setReadyToConnect(false);
    const selected = wallets.find((wallet) => wallet.adapter.name === walletName);
    if (!selected || ![WalletReadyState.Installed, WalletReadyState.Loadable].includes(selected.readyState)) {
      setUnavailableSelection(true);
      return;
    }
    setUnavailableSelection(false);
    setPreparingConnection(true);
    try {
      select(walletName);
      setReadyToConnect(true);
    } catch {
      setPreparationError(true);
    } finally {
      setPreparingConnection(false);
    }
  };

  useEffect(() => {
    if (
      !readyToConnect ||
      !selectedWallet ||
      unavailableSelection ||
      preparationError ||
      connectionError ||
      connected ||
      connecting ||
      wallet?.adapter.name !== selectedWallet
    ) return;

    const attemptKey = selectedWallet;
    if (connectionAttemptRef.current === attemptKey) return;
    connectionAttemptRef.current = attemptKey;
    void (async () => {
      try {
        // Clear a prior legacy Phantom site session after Wire has selected the
        // direct adapter; the Wallet Standard adapter may retain another account.
        if (selectedWallet === DIRECT_PHANTOM_ADAPTER_NAME) {
          const phantom = (window as WindowWithPhantom).phantom?.solana;
          if (phantom?.isConnected) await phantom.disconnect?.();
        }
        await connect();
      } catch {
        // Covers failures from both Phantom's injected provider and WalletProvider.
        setPreparationError(true);
        setReadyToConnect(false);
      }
    })();
  }, [connect, connected, connecting, connectionError, preparationError, readyToConnect, selectedWallet, unavailableSelection, wallet]);

  useEffect(() => {
    if (connected) close();
  }, [close, connected]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [close]);

  const hasWallets = listedWallets.length > 0;
  const installableWallets = hasWallets ? collapsedWallets : selectableWallets;

  return (
    <div
      className="wallet-adapter-modal wallet-adapter-modal-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wire-wallet-modal-title"
      ref={dialogRef}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="wallet-adapter-modal-container">
        <div className="wallet-adapter-modal-wrapper">
          <button type="button" onClick={close} className="wallet-adapter-modal-button-close" aria-label={t('Cerrar')}>
            <svg width="14" height="14" aria-hidden="true"><path d="M14 12.461 8.3 6.772l5.234-5.233L12.006 0 6.772 5.234 1.54 0 0 1.539l5.234 5.233L0 12.006l1.539 1.528L6.772 8.3l5.69 5.7L14 12.461z" /></svg>
          </button>

          {hasWallets ? (
            <>
              <h1 id="wire-wallet-modal-title" className="wallet-adapter-modal-title">{t('Conecta una wallet de Solana para continuar')}</h1>
              <ul className="wallet-adapter-modal-list">
                {listedWallets.map((wallet) => (
                  <li key={wallet.adapter.name}>
                    <button type="button" className="wallet-adapter-button" onClick={() => selectWallet(wallet.adapter.name)}>
                      <img className="wallet-adapter-button-start-icon" src={wallet.adapter.icon} alt="" aria-hidden="true" />
                      {walletDisplayName(wallet.adapter.name)}
                      <span>{t(wallet.readyState === WalletReadyState.Installed ? 'Detectada' : 'No detectada')}</span>
                    </button>
                  </li>
                ))}
                {collapsedWallets.length > 0 && expanded && collapsedWallets.map((wallet) => (
                  <li key={wallet.adapter.name}>
                    <button type="button" className="wallet-adapter-button" onClick={() => selectWallet(wallet.adapter.name)}>
                      <img className="wallet-adapter-button-start-icon" src={wallet.adapter.icon} alt="" aria-hidden="true" />
                      {walletDisplayName(wallet.adapter.name)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h1 id="wire-wallet-modal-title" className="wallet-adapter-modal-title">{t('Necesitas una wallet de Solana para continuar')}</h1>
              <p className="px-5 pb-3 text-center text-sm leading-relaxed text-[var(--muted)]">{t('Instala una wallet compatible o muestra las opciones disponibles.')}</p>
            </>
          )}

          {installableWallets.length > 0 && (
            <button
              type="button"
              className="wallet-adapter-modal-list-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <span>{expanded ? t(hasWallets ? 'Menos opciones' : 'Ocultar opciones') : t(hasWallets ? 'Más opciones' : '¿Ya tienes una wallet? Ver opciones')}</span>
              <svg width="13" height="7" viewBox="0 0 13 7" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className={expanded ? 'wallet-adapter-modal-list-more-icon-rotate' : ''}>
                <path d="M0.71418 1.626L5.83323 6.26188C5.91574 6.33657 6.0181 6.39652 6.13327 6.43762C6.24844 6.47872 6.37371 6.5 6.50048 6.5C6.62725 6.5 6.75252 6.47872 6.8677 6.43762C6.98287 6.39652 7.08523 6.37371 7.16774 6.26188L12.2868 1.626C12.7753 1.1835 12.3703 0.5 11.6195 0.5H1.37997C0.629216 0.5 0.224175 1.1835 0.71418 1.626Z" />
              </svg>
            </button>
          )}

          {!hasWallets && expanded && installableWallets.length > 0 && (
            <ul className="wallet-adapter-modal-list">
              {installableWallets.map((wallet) => (
                <li key={wallet.adapter.name}>
                  <button type="button" className="wallet-adapter-button" onClick={() => selectWallet(wallet.adapter.name)}>
                    <img className="wallet-adapter-button-start-icon" src={wallet.adapter.icon} alt="" aria-hidden="true" />
                    {walletDisplayName(wallet.adapter.name)}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selectedWallet && (
            <p
              role={connectionError || unavailableSelection || preparationError ? 'alert' : 'status'}
              aria-live={connectionError || unavailableSelection || preparationError ? 'assertive' : 'polite'}
              className={`mx-5 mt-3 rounded-lg border p-3 text-center text-xs leading-5 ${
                connectionError || unavailableSelection || preparationError
                  ? 'border-red-400/30 bg-red-400/10 text-red-200'
                  : 'border-white/10 bg-white/[0.03] text-[var(--muted)]'
              }`}
            >
              {connectionError || unavailableSelection || preparationError
                ? t('No se pudo conectar con {wallet}. Revisa que esté instalada y desbloqueada, y vuelve a intentarlo.', {
                    wallet: walletDisplayName(connectionError?.walletName) || walletDisplayName(selectedWallet),
                  })
                : t(connecting || preparingConnection ? 'Conectando con {wallet}…' : 'Solicitando conexión a {wallet}…', {
                    wallet: walletDisplayName(selectedWallet),
                  })}
            </p>
          )}
        </div>
      </div>
      <div className="wallet-adapter-modal-overlay" onMouseDown={close} />
    </div>
  );
}

export default function LocalizedWalletModalProvider({
  children,
  connectionError,
  clearConnectionError,
}: {
  children: ReactNode;
  connectionError: WalletConnectionError;
  clearConnectionError: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const close = useCallback(() => setVisible(false), []);
  const context = useMemo(() => ({ visible, setVisible }), [visible]);

  return (
    <WalletModalContext.Provider value={context}>
      {children}
      {visible && (
        <LocalizedWalletDialog
          close={close}
          connectionError={connectionError}
          clearConnectionError={clearConnectionError}
        />
      )}
    </WalletModalContext.Provider>
  );
}
