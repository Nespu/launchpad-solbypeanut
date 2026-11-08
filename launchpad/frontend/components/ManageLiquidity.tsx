'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Droplets, ExternalLink, Plus, LockKeyhole, Flame } from 'lucide-react';
import { useWallet } from '@solana/wallet-adapter-react';
import WithdrawLiquidity from './WithdrawLiquidity';
import LpBurnPanel from './LpBurnPanel';
import LpLockPanel from './LpLockPanel';
import { useWalletIdentity } from './WalletIdentityProvider';
import { userFacingError } from './toastEvents';
import { useWireLocale } from './LocaleProvider';
import { getWalletVaultMetadata, unlockWalletVault, type VaultWallet, type WalletVaultSession } from '../lib/walletVault';

type Pool = {
  mintAddress: string;
  name: string;
  symbol: string;
  imageUrl: string;
  poolAddress: string;
  poolQuoteMint: string;
  createdAt: string;
};

export default function ManageLiquidity() {
  const { t } = useWireLocale();
  const translateRef = useRef(t);
  const { publicKey } = useWallet();
  const { identifiedWallet, identifyWallet } = useWalletIdentity();
  const walletAddress = publicKey?.toBase58() ?? null;
  const connectedWalletIsIdentified = Boolean(walletAddress && identifiedWallet === walletAddress);
  const [vaultWallets, setVaultWallets] = useState<VaultWallet[]>([]);
  const [vaultSession, setVaultSession] = useState<WalletVaultSession | null>(null);
  const vaultSessionRef = useRef<WalletVaultSession | null>(null);
  const [selectedVaultAddress, setSelectedVaultAddress] = useState('');
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [activeVaultAddress, setActiveVaultAddress] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState('');
  const [vaultNotice, setVaultNotice] = useState('');
  const [pools, setPools] = useState<Pool[]>([]);
  const [selectedPool, setSelectedPool] = useState<Pool | null>(null);
  const [selectedPoolAction, setSelectedPoolAction] = useState<'withdraw' | 'burn' | 'lock'>('withdraw');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const activeWalletAddress = activeVaultAddress ?? walletAddress;
  const isIdentified = activeVaultAddress
    ? Boolean(vaultSession?.wallets.some((wallet) => wallet.address === activeVaultAddress))
    : connectedWalletIsIdentified;
  const activeVaultWallet = activeVaultAddress
    ? vaultSession?.wallets.find((wallet) => wallet.address === activeVaultAddress) ?? null
    : null;

  useEffect(() => { translateRef.current = t; }, [t]);

  useEffect(() => {
    let active = true;
    getWalletVaultMetadata()
      .then((metadata) => {
        if (!active) return;
        setVaultWallets(metadata.wallets);
        setSelectedVaultAddress((current) => current || metadata.wallets[0]?.address || '');
      })
      .catch((error: unknown) => {
        if (active) setVaultError(userFacingError(error, t('No se pudo leer la bóveda local.'), t));
      });
    return () => { active = false; };
  }, [t]);

  useEffect(() => () => {
    vaultSessionRef.current?.lock();
    vaultSessionRef.current = null;
  }, []);

  const authenticateVaultWallet = async (address: string, session: WalletVaultSession) => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
    const challengeResponse = await fetch(`${apiUrl}/api/auth/challenge`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: address }),
    });
    const challenge = await challengeResponse.json();
    if (!challengeResponse.ok || !challenge.success || typeof challenge.message !== 'string') {
      throw new Error(challenge.error || t('No se pudo iniciar sesión con la wallet de la bóveda.'));
    }
    const signatureBytes = await session.signAuthenticationMessage(address, new TextEncoder().encode(challenge.message));
    const signature = btoa(Array.from(signatureBytes, (byte) => String.fromCharCode(byte)).join(''));
    const verifyResponse = await fetch(`${apiUrl}/api/auth/verify`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: address, message: challenge.message, signature }),
    });
    const verified = await verifyResponse.json();
    if (!verifyResponse.ok || !verified.success || verified.wallet !== address) {
      throw new Error(verified.error || t('Wire no pudo confirmar la wallet de la bóveda.'));
    }
    window.dispatchEvent(new Event('wire:wallet-session-changed'));
  };

  const handleUseVaultWallet = async () => {
    if (!selectedVaultAddress || !vaultWallets.some((wallet) => wallet.address === selectedVaultAddress)) {
      setVaultError(t('Selecciona una wallet guardada en la bóveda.'));
      return;
    }
    setVaultBusy(true);
    setVaultError('');
    setVaultNotice('');
    let session = vaultSessionRef.current;
    try {
      if (!session || session.isLocked) {
        if (!vaultPassphrase) throw new Error(t('Escribe la contraseña de la bóveda para desbloquearla.'));
        session = await unlockWalletVault(vaultPassphrase);
        vaultSessionRef.current = session;
        setVaultSession(session);
      }
      if (!session.wallets.some((wallet) => wallet.address === selectedVaultAddress)) {
        throw new Error(t('La wallet seleccionada ya no está en la bóveda. Actualiza la lista e inténtalo de nuevo.'));
      }
      await authenticateVaultWallet(selectedVaultAddress, session);
      setActiveVaultAddress(selectedVaultAddress);
      setVaultWallets(session.wallets);
      setVaultPassphrase('');
      setVaultNotice(t('Wallet de la bóveda activa para consultar pools y preparar retiros.'));
      setSelectedPool(null);
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setVaultError(userFacingError(error, t('No se pudo usar la wallet de la bóveda.'), t));
    } finally {
      setVaultBusy(false);
    }
  };

  const handleUseConnectedWallet = async () => {
    setVaultBusy(true);
    setVaultError('');
    setVaultNotice('');
    try {
      if (!publicKey) throw new Error(t('Conecta una wallet Solana para usarla en Administrar liquidez.'));
      await identifyWallet();
      vaultSessionRef.current?.lock();
      vaultSessionRef.current = null;
      setVaultSession(null);
      setActiveVaultAddress(null);
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setVaultError(userFacingError(error, t('No se pudo identificar la wallet conectada.'), t));
    } finally {
      setVaultBusy(false);
    }
  };

  const handleLockVault = () => {
    vaultSessionRef.current?.lock();
    vaultSessionRef.current = null;
    setVaultSession(null);
    setActiveVaultAddress(null);
    setVaultPassphrase('');
    setVaultNotice(t('Bóveda bloqueada.'));
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    if (!activeWalletAddress || !isIdentified) {
      setPools([]);
      setLoading(false);
      setError('');
      setSelectedPool(null);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setError('');
    fetch((process.env.NEXT_PUBLIC_API_URL || '') + '/api/my-pools', {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
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
        if (active && !(err instanceof Error && err.name === 'AbortError')) {
          const message = userFacingError(err, translateRef.current('No se pudieron cargar tus pools.'), translateRef.current);
          setError(message);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [activeWalletAddress, isIdentified, refreshVersion]);

  if (selectedPool && activeWalletAddress && isIdentified) {
    if (selectedPoolAction === 'lock') {
      return (
        <LpLockPanel
          poolAddress={selectedPool.poolAddress}
          walletAddress={activeWalletAddress}
          vaultSigner={activeVaultWallet && vaultSession ? {
            signTransaction: (transaction) => vaultSession.signTransaction(activeVaultWallet.address, transaction),
          } : undefined}
          onBack={() => setSelectedPool(null)}
        />
      );
    }
    if (selectedPoolAction === 'burn') {
      return (
        <LpBurnPanel
          poolAddress={selectedPool.poolAddress}
          walletAddress={activeWalletAddress}
          vaultSigner={activeVaultWallet && vaultSession ? {
            signTransaction: (transaction) => vaultSession.signTransaction(activeVaultWallet.address, transaction),
          } : undefined}
          onBack={() => setSelectedPool(null)}
        />
      );
    }
    return (
      <WithdrawLiquidity
        poolAddress={selectedPool.poolAddress}
        tokenMintAddress={selectedPool.mintAddress}
        quoteMint={selectedPool.poolQuoteMint}
        vaultSigner={activeVaultWallet && vaultSession ? {
          address: activeVaultWallet.address,
          label: activeVaultWallet.label,
          signTransaction: (transaction) => vaultSession.signTransaction(activeVaultWallet.address, transaction),
        } : undefined}
        onBack={() => setSelectedPool(null)}
      />
    );
  }

  return (
    <section className="wire-page-section" aria-labelledby="liquidity-title">
      <header className="wire-page-heading">
        <div>
          <p className="wire-kicker mb-3"><span className="wire-status-dot" aria-hidden="true" />SOLANA · DEVNET</p>
          <h2 id="liquidity-title" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('Administrar liquidez')}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)] sm:text-base">
            {t('Consulta tus pools y revisa el saldo disponible antes de iniciar un retiro.')}
          </p>
        </div>
        <Link href="/" className="wire-button wire-button-primary shrink-0">
          <Plus size={16} aria-hidden="true" />{t('Crear token')}
        </Link>
      </header>

      <section className="wire-panel mt-6 space-y-4 p-4 sm:p-5" aria-labelledby="liquidity-wallet-title">
        <div>
          <h3 id="liquidity-wallet-title" className="font-display text-lg font-semibold">{t('Wallet para administrar')}</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Consulta las pools y los LP de una wallet creadora. La bóveda firma el reto de acceso y cada retiro localmente en este navegador; la clave privada nunca se envía a Wire.')}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="grid gap-1.5 text-sm">
            <label htmlFor="liquidity-vault-wallet">{t('Wallet de la bóveda')}</label>
            <select id="liquidity-vault-wallet" value={selectedVaultAddress} onChange={(event) => setSelectedVaultAddress(event.target.value)} disabled={vaultBusy || vaultWallets.length === 0} className="wire-input min-h-11 w-full">
              {vaultWallets.length === 0 ? <option value="">{t('No hay wallets guardadas')}</option> : vaultWallets.map((wallet) => <option key={wallet.address} value={wallet.address}>{wallet.label || t('Wallet')} · {wallet.address.slice(0, 6)}…{wallet.address.slice(-6)}</option>)}
            </select>
          </div>
          {!vaultSession ? (
            <div className="grid gap-1.5 text-sm">
              <label htmlFor="liquidity-vault-passphrase">{t('Contraseña de la bóveda')}</label>
              <input id="liquidity-vault-passphrase" type="password" autoComplete="current-password" value={vaultPassphrase} onChange={(event) => setVaultPassphrase(event.target.value)} disabled={vaultBusy} className="wire-input min-h-11 w-full" />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
              <span>{t('Bóveda desbloqueada solo en este navegador. Bloquéala al terminar.')}</span>
              <button type="button" onClick={handleLockVault} disabled={vaultBusy} className="wire-button wire-button-quiet min-h-11 px-3">{t('Bloquear bóveda')}</button>
            </div>
          )}
          <button type="button" onClick={() => void handleUseVaultWallet()} disabled={vaultBusy || vaultWallets.length === 0 || (!vaultSession && !vaultPassphrase)} className="wire-button wire-button-secondary min-h-11 px-4">
            {vaultBusy ? t('Preparando wallet…') : vaultSession ? t('Usar wallet seleccionada') : <><LockKeyhole size={14} aria-hidden="true" />{t('Desbloquear y usar')}</>}
          </button>
        </div>
        {publicKey && (activeVaultAddress || !connectedWalletIsIdentified) && (
          <button type="button" onClick={() => void handleUseConnectedWallet()} disabled={vaultBusy} className="wire-button wire-button-quiet min-h-11 px-3 text-xs">
            {t(activeVaultAddress ? 'Volver a wallet conectada' : 'Usar wallet conectada')}
          </button>
        )}
        {activeWalletAddress && isIdentified && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-3 text-sm" role="status">
            <span>{t('Wallet activa')}: <strong>{activeVaultWallet?.label || t('Wallet conectada')}</strong> <code className="break-all text-xs text-[var(--muted)]">{activeWalletAddress}</code></span>
          </div>
        )}
        {vaultError && <p className="text-sm text-[var(--danger)]" role="alert">{vaultError}</p>}
        {vaultNotice && <p className="text-sm text-[var(--success)]" role="status">{vaultNotice}</p>}
        {vaultWallets.length === 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-xs text-[var(--muted)]">{t('Crea o importa una wallet local para usar este flujo.')}</p>
            <Link href="/wallets" className="wire-button wire-button-quiet text-sm">{t('Abrir Mis wallets')}</Link>
          </div>
        )}
      </section>

      {isIdentified && (
        <div className="wire-page-summary" aria-live="polite">
          <span className="wire-summary-icon"><Droplets size={18} aria-hidden="true" /></span>
          <span><strong>{pools.length}</strong> {pools.length === 1 ? t('pool registrada') : t('pools registradas')}</span>
          <span className="wire-summary-network">Solana Devnet</span>
        </div>
      )}

      <div className="wire-pool-results">
      {!activeWalletAddress ? (
        <div className="wire-empty-state">
          <span className="wire-empty-icon"><Droplets size={24} aria-hidden="true" /></span>
          <h3>{t('Selecciona una wallet')}</h3>
          <p>{t('Inicia sesión con la wallet conectada o elige una wallet de la bóveda para consultar sus pools.')}</p>
        </div>
      ) : !isIdentified ? (
        <div className="wire-empty-state">
          <span className="wire-empty-icon"><Droplets size={24} aria-hidden="true" /></span>
          <h3>{t('Inicia sesión para ver tus pools')}</h3>
          <p>{t('Autentica esta wallet desde el panel Wallet o desde el selector local de la bóveda. La firma de acceso no envía SOL.')}</p>
        </div>
      ) : loading ? (
        <div className="wire-empty-state" role="status"><span className="wire-loading-mark" aria-hidden="true" /><h3>{t('Cargando tus pools')}</h3><p>{t('Estamos consultando la actividad de esta wallet.')}</p></div>
      ) : error ? (
        <div className="wire-empty-state wire-empty-error" role="alert">
          <h3>{t('No se pudieron cargar tus pools')}</h3>
          <p>{error}</p>
          <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} className="wire-button wire-button-secondary mt-2">{t('Reintentar')}</button>
        </div>
      ) : pools.length === 0 ? (
        <div className="wire-empty-state">
          <span className="wire-empty-icon"><Droplets size={24} aria-hidden="true" /></span>
          <h3>{t('Aún no tienes pools')}</h3>
          <p>{t('Cuando configures liquidez para un token, aparecerá aquí.')}</p>
          <Link href="/" className="wire-button wire-button-secondary mt-2">{t('Ir a crear token')} <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      ) : (
        <div className="wire-pool-grid">
          {pools.map((pool) => (
            <article key={pool.mintAddress} className="wire-pool-card">
              <div className="wire-pool-card-main">
                {pool.imageUrl ? (
                  <img src={pool.imageUrl} alt="" className="wire-pool-avatar" />
                ) : (
                  <span className="wire-pool-avatar wire-pool-avatar-fallback" aria-hidden="true">{(pool.symbol || 'W').slice(0, 1)}</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="wire-pool-eyebrow">POOL · DEVNET · {pool.poolQuoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC'}</div>
                  <h3 className="mt-1 truncate font-display text-lg font-semibold">
                    <Link href={`/token/${pool.mintAddress}`} className="hover:text-[var(--wire-green)]">{pool.name} <span className="text-[var(--muted)]">({pool.symbol})</span></Link>
                  </h3>
                  <p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">{pool.poolAddress}</p>
                </div>
              </div>
              <div className="wire-pool-card-actions flex flex-wrap gap-2">
                <Link href={`/token/${pool.mintAddress}`} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center sm:flex-none">{t('Detalles')} <ExternalLink size={14} aria-hidden="true" /></Link>
                <button type="button" onClick={() => { setSelectedPoolAction('withdraw'); setSelectedPool(pool); }} className="wire-button wire-button-primary min-h-11 flex-1 justify-center sm:flex-none">
                  {t('Ver saldo LP')} <ArrowRight size={15} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => { setSelectedPoolAction('burn'); setSelectedPool(pool); }} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center sm:flex-none">
                  <Flame size={15} aria-hidden="true" />{t('Quema de LP')}
                </button>
                <button type="button" onClick={() => { setSelectedPoolAction('lock'); setSelectedPool(pool); }} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center sm:flex-none">
                  <LockKeyhole size={15} aria-hidden="true" />{t('Bloquear LP 180 días')}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      </div>
    </section>
  );
}
