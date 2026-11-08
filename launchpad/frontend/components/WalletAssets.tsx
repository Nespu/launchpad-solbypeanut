'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, type ParsedAccountData } from '@solana/web3.js';
import { ExternalLink, Eye, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useWireLocale } from './LocaleProvider';
import { userFacingError } from './toastEvents';
import { getWalletVaultMetadata, type VaultWallet, type VaultWalletRole } from '../lib/walletVault';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';

const TOKEN_PROGRAM_IDS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
];
const WATCH_WALLETS_STORAGE_KEY = 'wire:watch-wallets:v1';
const MAX_WATCH_WALLETS = 10;
const MAX_RPC_REQUESTS_IN_FLIGHT = 6;
let rpcRequestsInFlight = 0;
const rpcRequestQueue: Array<() => void> = [];

type WatchWallet = {
  address: string;
  label: string;
  group: WalletGroup;
};

type WalletGroup = 'dev' | 'bundle' | 'snipe';
type WalletGroupFilter = 'all' | WalletGroup;
const WALLET_GROUPS: WalletGroup[] = ['dev', 'bundle', 'snipe'];

function groupLabel(group: WalletGroup, t: (message: string, values?: Record<string, string | number>) => string) {
  return t(group === 'dev' ? 'Dev' : group === 'bundle' ? 'Bundle' : 'Snipe');
}

function vaultRoleLabel(role: VaultWalletRole, t: (message: string, values?: Record<string, string | number>) => string) {
  return t(role === 'dev' ? 'Dev' : role === 'bundle' ? 'Bundle' : role === 'snipe' ? 'Snipe' : role === 'trading' ? 'Trading' : 'Holder');
}

type WalletTokenBalance = {
  mint: string;
  rawAmount: string;
  decimals: number;
};

type WalletAssetsSnapshot = {
  owner: string;
  solLamports: string;
  tokens: WalletTokenBalance[];
  updatedAt: number;
};

function formatRawAmount(rawAmount: string, decimals: number, locale: 'es' | 'en') {
  const raw = BigInt(rawAmount);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const numberLocale = locale === 'es' ? 'es-419' : 'en-US';
  const wholeText = new Intl.NumberFormat(numberLocale).format(whole);
  if (!fraction) return wholeText;
  const decimal = new Intl.NumberFormat(numberLocale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return `${wholeText}${decimal}${fraction}`;
}

function explorerAddress(address: string) {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}

function shortenAddress(address: string) {
  return `${address.slice(0, 5)}…${address.slice(-5)}`;
}

function releaseRpcSlot() {
  const next = rpcRequestQueue.shift();
  if (next) next();
  else rpcRequestsInFlight -= 1;
}

async function withRpcSlot<T>(request: () => Promise<T>, isActive: () => boolean): Promise<T> {
  if (!isActive()) throw new Error('Wallet request cancelled.');
  if (rpcRequestsInFlight < MAX_RPC_REQUESTS_IN_FLIGHT) {
    rpcRequestsInFlight += 1;
  } else {
    await new Promise<void>((resolve) => rpcRequestQueue.push(resolve));
  }
  if (!isActive()) {
    releaseRpcSlot();
    throw new Error('Wallet request cancelled.');
  }
  try {
    return await request();
  } finally {
    releaseRpcSlot();
  }
}

function readWatchWallets(value: string | null): WatchWallet[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const wallets: WatchWallet[] = [];
    const addresses = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as { address?: unknown; label?: unknown; group?: unknown };
      if (typeof candidate.address !== 'string') continue;
      try {
        const address = new PublicKey(candidate.address).toBase58();
        if (addresses.has(address)) continue;
        addresses.add(address);
        wallets.push({
          address,
          label: typeof candidate.label === 'string' ? candidate.label.trim().slice(0, 32) : '',
          group: candidate.group === 'dev' || candidate.group === 'bundle' || candidate.group === 'snipe'
            ? candidate.group
            : 'bundle',
        });
        if (wallets.length >= MAX_WATCH_WALLETS) break;
      } catch {
        // Ignore malformed entries from older or manually edited browser storage.
      }
    }
    return wallets;
  } catch {
    return [];
  }
}

function WalletAssetCard({
  address,
  label,
  group,
  connected,
  onRemove,
  onGroupChange,
}: {
  address: string;
  label: string;
  group: WalletGroup;
  connected: boolean;
  onRemove?: () => void;
  onGroupChange?: (group: WalletGroup) => void;
}) {
  const { connection } = useConnection();
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const [snapshot, setSnapshot] = useState<WalletAssetsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => { translateRef.current = t; }, [t]);

  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  useEffect(() => {
    let active = true;
    const owner = new PublicKey(address);
    setLoading(true);
    setError('');
    setWarning('');

    withRpcSlot(() => connection.getGenesisHash(), () => active)
      .then((genesisHash) => {
        if (genesisHash !== DEVNET_GENESIS_HASH) {
          throw new Error(translateRef.current('La conexión RPC no está en Solana Devnet.'));
        }
        return Promise.allSettled([
          withRpcSlot(() => connection.getBalance(owner, 'confirmed'), () => active),
          withRpcSlot(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_IDS[0] }, 'confirmed'), () => active),
          withRpcSlot(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_IDS[1] }, 'confirmed'), () => active),
        ]);
      })
      .then(([solResult, tokenResult, token2022Result]) => {
        if (solResult.status === 'rejected') throw solResult.reason;
        const totals = new Map<string, { rawAmount: bigint; decimals: number }>();
        let malformedAccount = false;
        const accountGroups = [tokenResult, token2022Result]
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value.value);

        for (const accounts of accountGroups) {
          for (const account of accounts) {
            const parsed = (account.account.data as ParsedAccountData).parsed as {
              info?: {
                mint?: string;
                tokenAmount?: { amount?: string; decimals?: number };
              };
            } | undefined;
            if (!parsed || typeof parsed !== 'object') {
              malformedAccount = true;
              continue;
            }
            const mint = parsed.info?.mint;
            const rawAmount = parsed.info?.tokenAmount?.amount;
            const decimals = parsed.info?.tokenAmount?.decimals;
            if (!mint || !rawAmount || !/^\d+$/.test(rawAmount) || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
              malformedAccount = true;
              continue;
            }

            const raw = BigInt(rawAmount);
            const current = totals.get(mint);
            if (current && current.decimals !== decimals) {
              malformedAccount = true;
              continue;
            }
            totals.set(mint, { rawAmount: (current?.rawAmount ?? 0n) + raw, decimals });
          }
        }

        const tokens = Array.from(totals.entries())
          .filter(([, balance]) => balance.rawAmount > 0n)
          .map(([mint, balance]) => ({ mint, rawAmount: balance.rawAmount.toString(), decimals: balance.decimals }))
          .sort((left, right) => left.mint.localeCompare(right.mint));

        if (active) {
          setSnapshot({ owner: address, solLamports: String(solResult.value), tokens, updatedAt: Date.now() });
          if (tokenResult.status === 'rejected' || token2022Result.status === 'rejected' || malformedAccount) {
            setWarning(translateRef.current('No se pudieron leer todas las cuentas de tokens; la lista puede estar incompleta.'));
          }
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(userFacingError(
            caught,
            translateRef.current('No se pudieron consultar los activos de esta wallet. Inténtalo de nuevo.'),
            translateRef.current,
          ));
        }
      })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [address, connection, refreshVersion]);

  const currentSnapshot = snapshot?.owner === address ? snapshot : null;
  const displayName = label || shortenAddress(address);

  return (
    <article className="wire-panel overflow-hidden p-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold">{connected ? t('Wallet conectada') : displayName}</h3>
            {onGroupChange ? (
              <select
                aria-label={t('Cambiar grupo de {wallet}', { wallet: displayName })}
                value={group}
                onChange={(event) => onGroupChange(event.target.value as WalletGroup)}
                className="wire-input min-h-11 w-auto px-2 py-1 text-xs text-[var(--wire-green)]"
              >
                {WALLET_GROUPS.map((walletGroup) => <option key={walletGroup} value={walletGroup}>{groupLabel(walletGroup, t)}</option>)}
              </select>
            ) : (
              <span className="rounded-full border border-[var(--line)] px-2 py-1 text-[.65rem] font-medium text-[var(--wire-green)]">{groupLabel(group, t)}</span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2 py-1 text-[.65rem] text-[var(--muted)]">
              {connected ? t('Activa') : <><Eye size={11} aria-hidden="true" />{t('Solo lectura')}</>}
            </span>
          </div>
          <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1 font-mono text-xs text-[var(--muted)] hover:text-[var(--text)]">
            {shortenAddress(address)}<ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={refresh} disabled={loading} className="wire-button wire-button-secondary min-h-11 px-3" aria-label={t('Actualizar balances de {wallet}', { wallet: displayName })}>
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />{t('Actualizar')}
          </button>
          {onRemove && (
            <button type="button" onClick={onRemove} className="wire-button wire-button-quiet min-h-11 min-w-11 p-0" aria-label={t('Quitar wallet {wallet}', { wallet: displayName })}>
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {loading && !currentSnapshot ? (
        <div className="flex min-h-24 items-center justify-center gap-3 px-4 py-6 text-sm text-[var(--muted)]" role="status" aria-live="polite">
          <span className="wire-loading-mark" aria-hidden="true" />{t('Consultando activos de la wallet')}
        </div>
      ) : error ? (
        <div className="px-4 py-4 sm:px-5" role="alert">
          <p className="text-sm text-[var(--muted)]">{error}</p>
          <button type="button" onClick={refresh} className="wire-button wire-button-secondary mt-3 min-h-11">{t('Reintentar')}</button>
        </div>
      ) : currentSnapshot ? (
        <>
          {warning && <p className="border-b border-[var(--line)] px-4 py-3 text-sm text-[var(--muted)]" role="status">{warning}</p>}
          <ul className="divide-y divide-[var(--line)]">
            <li className="flex flex-wrap items-center gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <h4 className="font-semibold">Solana <span className="text-[var(--muted)]">(SOL)</span></h4>
                <p className="mt-1 text-xs text-[var(--muted)]">{t('Saldo nativo')}</p>
              </div>
              <strong className="min-w-0 max-w-full text-right font-mono text-sm tabular-nums [overflow-wrap:anywhere]">{formatRawAmount(currentSnapshot.solLamports, 9, locale)} SOL</strong>
            </li>
            {currentSnapshot.tokens.map((token) => (
              <li key={token.mint} className="flex flex-wrap items-center gap-4 px-4 py-4 sm:px-5">
                <div className="min-w-0 flex-1">
                  <h4 className="font-semibold">{t('Token')}</h4>
                  <p className="mt-1 text-xs text-[var(--muted)]">{t('Dirección mint')}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{token.mint}</p>
                </div>
                <strong className="min-w-0 max-w-full text-right font-mono text-sm tabular-nums [overflow-wrap:anywhere]">{formatRawAmount(token.rawAmount, token.decimals, locale)}</strong>
                <a href={explorerAddress(token.mint)} target="_blank" rel="noreferrer" className="wire-button wire-button-quiet min-h-11 px-2 text-xs">
                  {t('Ver en Explorer')}<ExternalLink size={13} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
          {currentSnapshot.tokens.length === 0 && (
            <p className="border-t border-[var(--line)] px-4 py-3 text-sm text-[var(--muted)] sm:px-5">{t('No se encontraron balances de tokens en esta wallet.')}</p>
          )}
          <p className="border-t border-[var(--line)] px-4 py-3 text-xs text-[var(--muted)] sm:px-5">
            {t('Actualizado {time}', { time: new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { timeStyle: 'short' }).format(new Date(currentSnapshot.updatedAt)) })}
          </p>
        </>
      ) : null}
    </article>
  );
}

function ProjectWalletBalances() {
  const { connection } = useConnection();
  const { locale, t } = useWireLocale();
  const [wallets, setWallets] = useState<VaultWallet[]>([]);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [expandedWallets, setExpandedWallets] = useState<Set<string>>(() => new Set());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getWalletVaultMetadata()
      .then(async (metadata) => {
        if (!active) return;
        setWallets(metadata.wallets);
        if (!metadata.wallets.length) {
          setBalances({});
          setUpdatedAt(null);
          return;
        }
        if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
          throw new Error(t('La conexión RPC no está en Solana Devnet.'));
        }
        const accounts = await connection.getMultipleAccountsInfo(
          metadata.wallets.map((wallet) => new PublicKey(wallet.address)),
          'confirmed',
        );
        if (!active) return;
        setBalances(Object.fromEntries(metadata.wallets.map((wallet, index) => [
          wallet.address,
          String(accounts[index]?.lamports ?? 0),
        ])));
        setUpdatedAt(Date.now());
      })
      .catch((caught: unknown) => {
        if (active) setError(userFacingError(caught, t('No se pudieron cargar los balances de la bóveda.'), t));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connection, refreshVersion, t]);

  if (!wallets.length && !loading && !error) return null;

  return (
    <details className="wire-panel mb-4 p-4 sm:p-5">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-3 font-semibold">
        <span>{t('Balances SOL de wallets de proyecto')} <span className="text-xs font-normal text-[var(--muted)]">({wallets.length})</span></span>
        <span className="flex items-center gap-2">
          {loading && <span className="wire-loading-mark" aria-hidden="true" />}
          <span className="text-xs font-normal text-[var(--muted)]">{t('Solo lectura · Devnet')}</span>
        </span>
      </summary>
      <div className="mt-3 border-t border-[var(--line)] pt-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-2xl text-xs leading-relaxed text-[var(--muted)]">{t('Estos balances usan las direcciones públicas de la bóveda. Las claves locales no se desbloquean ni participan en esta consulta.')}</p>
          <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} disabled={loading} className="wire-button wire-button-secondary min-h-11 px-3 text-sm"><RefreshCw size={13} aria-hidden="true" className={loading ? 'animate-spin' : ''} />{t('Actualizar balances')}</button>
        </div>
        {error ? (
          <div role="alert" className="rounded-lg border border-[var(--danger,#ff8b8b)]/40 p-3 text-sm text-[var(--muted)]">
            <p>{error}</p>
            <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} className="wire-button wire-button-secondary mt-2 min-h-11">{t('Reintentar')}</button>
          </div>
        ) : loading && !wallets.length ? (
          <p className="flex items-center gap-2 text-sm text-[var(--muted)]" role="status"><span className="wire-loading-mark" aria-hidden="true" />{t('Consultando wallets de proyecto…')}</p>
        ) : wallets.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {wallets.map((wallet) => (
              <li key={wallet.address} className="grid min-w-0 gap-2 rounded-lg border border-[var(--line)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span className="min-w-0"><span className="flex flex-wrap items-center gap-2 text-sm font-medium">{wallet.label || shortenAddress(wallet.address)}<span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--muted)]">{vaultRoleLabel(wallet.role, t)}</span></span><a href={explorerAddress(wallet.address)} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-xs text-[var(--muted)] hover:text-[var(--text)]">{shortenAddress(wallet.address)}<ExternalLink size={11} aria-hidden="true" /></a></span>
                <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
                  <strong className="min-w-0 max-w-full text-right font-mono text-sm tabular-nums [overflow-wrap:anywhere]">{balances[wallet.address] !== undefined ? formatRawAmount(balances[wallet.address], 9, locale) : '—'} SOL</strong>
                  <button
                    type="button"
                    aria-expanded={expandedWallets.has(wallet.address)}
                    aria-controls={`project-wallet-token-balances-${wallet.address}`}
                    onClick={() => setExpandedWallets((current) => {
                      const next = new Set(current);
                      if (next.has(wallet.address)) next.delete(wallet.address);
                      else next.add(wallet.address);
                      return next;
                    })}
                    className="wire-button wire-button-secondary min-h-11 px-2.5 text-xs"
                  >
                    <Eye size={13} aria-hidden="true" />{expandedWallets.has(wallet.address) ? t('Ocultar tokens') : t('Mostrar tokens')}
                  </button>
                </div>
                {expandedWallets.has(wallet.address) && (
                  <div id={`project-wallet-token-balances-${wallet.address}`} className="sm:col-span-2">
                    <ProjectWalletTokenBalances address={wallet.address} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--muted)]">{t('Todavía no hay wallets de proyecto')}</p>
        )}
        {updatedAt && <p className="mt-3 text-xs text-[var(--muted)]">{t('Actualizado {time}', { time: new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { timeStyle: 'short' }).format(new Date(updatedAt)) })}</p>}
      </div>
    </details>
  );
}

function ProjectWalletTokenBalances({ address }: { address: string }) {
  const { connection } = useConnection();
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const [tokens, setTokens] = useState<WalletTokenBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => { translateRef.current = t; }, [t]);

  useEffect(() => {
    let active = true;
    const owner = new PublicKey(address);
    setLoading(true);
    setError('');
    setWarning('');

    withRpcSlot(() => connection.getGenesisHash(), () => active)
      .then((genesisHash) => {
        if (genesisHash !== DEVNET_GENESIS_HASH) {
          throw new Error(translateRef.current('La conexión RPC no está en Solana Devnet.'));
        }
        return Promise.allSettled([
          withRpcSlot(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_IDS[0] }, 'confirmed'), () => active),
          withRpcSlot(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_IDS[1] }, 'confirmed'), () => active),
        ]);
      })
      .then(([legacyResult, token2022Result]) => {
        if (!active) return;
        const accountGroups = [legacyResult, token2022Result]
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value.value);
        if (accountGroups.length === 0) {
          throw (legacyResult.status === 'rejected' ? legacyResult.reason : token2022Result.status === 'rejected' ? token2022Result.reason : new Error('No se pudieron consultar los tokens de esta wallet.'));
        }
        const totals = new Map<string, { rawAmount: bigint; decimals: number }>();
        let malformedAccount = legacyResult.status === 'rejected' || token2022Result.status === 'rejected';
        for (const account of accountGroups.flat()) {
          const parsed = (account.account.data as ParsedAccountData).parsed as {
            info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } };
          } | undefined;
          const mint = parsed?.info?.mint;
          const rawAmount = parsed?.info?.tokenAmount?.amount;
          const decimals = parsed?.info?.tokenAmount?.decimals;
          if (!mint || typeof rawAmount !== 'string' || !/^\d+$/.test(rawAmount)
            || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
            malformedAccount = true;
            continue;
          }
          const current = totals.get(mint);
          if (current && current.decimals !== decimals) {
            malformedAccount = true;
            continue;
          }
          totals.set(mint, { rawAmount: (current?.rawAmount ?? 0n) + BigInt(rawAmount), decimals });
        }
        setTokens(Array.from(totals.entries())
          .filter(([, balance]) => balance.rawAmount > 0n)
          .map(([mint, balance]) => ({ mint, rawAmount: balance.rawAmount.toString(), decimals: balance.decimals }))
          .sort((left, right) => left.mint.localeCompare(right.mint)));
        setUpdatedAt(Date.now());
        if (malformedAccount) setWarning(t('No se pudieron leer todas las cuentas de tokens; la lista puede estar incompleta.'));
      })
      .catch((caught: unknown) => {
        if (active) setError(userFacingError(caught, translateRef.current('No se pudieron consultar los tokens de esta wallet.'), translateRef.current));
      })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [address, connection]);

  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3" aria-live="polite">
      {loading ? (
        <p className="flex items-center gap-2 text-xs text-[var(--muted)]"><span className="wire-loading-mark" aria-hidden="true" />{t('Consultando balances de tokens…')}</p>
      ) : error ? (
        <p className="text-xs text-[var(--danger,#ff8b8b)]" role="alert">{error}</p>
      ) : tokens.length ? (
        <ul className="grid gap-2">
          {tokens.map((token) => (
            <li key={token.mint} className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
              <a href={explorerAddress(token.mint)} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono text-[var(--muted)] hover:text-[var(--text)]">
                <span className="truncate">{shortenAddress(token.mint)}</span><ExternalLink size={11} aria-hidden="true" />
              </a>
              <strong className="min-w-0 max-w-full text-right font-mono tabular-nums [overflow-wrap:anywhere]">{formatRawAmount(token.rawAmount, token.decimals, locale)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--muted)]">{t('No se encontraron balances de tokens en esta wallet.')}</p>
      )}
      {warning && <p className="mt-2 text-xs text-[var(--muted)]">{warning}</p>}
      {updatedAt && <p className="mt-2 text-[10px] text-[var(--muted)]">{t('Actualizado {time}', { time: new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { timeStyle: 'short' }).format(new Date(updatedAt)) })}</p>}
    </div>
  );
}

export default function WalletAssets() {
  const { publicKey } = useWallet();
  const { t } = useWireLocale();
  const [watchWallets, setWatchWallets] = useState<WatchWallet[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [label, setLabel] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [newWalletGroup, setNewWalletGroup] = useState<WalletGroup>('bundle');
  const [groupFilter, setGroupFilter] = useState<WalletGroupFilter>('all');
  const [formError, setFormError] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const connectedAddress = publicKey?.toBase58() ?? '';
  const visibleWatchWallets = watchWallets.filter((wallet) => wallet.address !== connectedAddress);
  const filteredWatchWallets = groupFilter === 'all'
    ? visibleWatchWallets
    : visibleWatchWallets.filter((wallet) => wallet.group === groupFilter);
  const showConnectedWallet = Boolean(connectedAddress && (groupFilter === 'all' || groupFilter === 'dev'));
  const groupCounts: Record<WalletGroup, number> = {
    dev: (connectedAddress ? 1 : 0) + visibleWatchWallets.filter((wallet) => wallet.group === 'dev').length,
    bundle: visibleWatchWallets.filter((wallet) => wallet.group === 'bundle').length,
    snipe: visibleWatchWallets.filter((wallet) => wallet.group === 'snipe').length,
  };
  const totalWalletCount = visibleWatchWallets.length + (connectedAddress ? 1 : 0);

  useEffect(() => {
    try {
      setWatchWallets(readWatchWallets(window.localStorage.getItem(WATCH_WALLETS_STORAGE_KEY)));
    } catch {
      setWatchWallets([]);
    } finally {
      setStorageReady(true);
    }
  }, []);

  const persistWatchWallets = (next: WatchWallet[]) => {
    try {
      window.localStorage.setItem(WATCH_WALLETS_STORAGE_KEY, JSON.stringify(next));
      setWatchWallets(next);
      setFormError('');
      return true;
    } catch {
      setFormError(t('No se pudo guardar la lista en este navegador.'));
      return false;
    }
  };

  const handleAddWallet = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    let address: string;
    try {
      address = new PublicKey(addressInput.trim()).toBase58();
    } catch {
      setFormError(t('Escribe una dirección pública de Solana válida.'));
      return;
    }

    if (address === connectedAddress) {
      setFormError(t('La wallet conectada ya aparece en la lista.'));
      return;
    }
    if (watchWallets.some((wallet) => wallet.address === address)) {
      setFormError(t('Esta wallet ya está en la lista.'));
      return;
    }
    if (watchWallets.length >= MAX_WATCH_WALLETS) {
      setFormError(t('Máximo {count} wallets de solo lectura.', { count: MAX_WATCH_WALLETS }));
      return;
    }

    const next = [...watchWallets, { address, label: label.trim().slice(0, 32), group: newWalletGroup }];
    if (persistWatchWallets(next)) {
      setAddressInput('');
      setLabel('');
      setNewWalletGroup('bundle');
    }
  };

  const handleRemoveWallet = (address: string) => {
    persistWatchWallets(watchWallets.filter((wallet) => wallet.address !== address));
  };

  const handleImportWallets = async (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setFormError('');
    try {
      if (file.size > 64 * 1024) throw new Error('invalid-file');
      const parsed: unknown = JSON.parse(await file.text());
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { wallets?: unknown }).wallets)
          ? (parsed as { wallets: unknown[] }).wallets
          : null;
      if (!records || records.length > 100) throw new Error('invalid-file');

      const imported: WatchWallet[] = [];
      const addresses = new Set([...watchWallets.map((wallet) => wallet.address), connectedAddress]);
      for (const record of records) {
        const candidate = typeof record === 'string' ? { address: record } : record;
        if (!candidate || typeof candidate !== 'object' || typeof (candidate as { address?: unknown }).address !== 'string') {
          throw new Error('invalid-file');
        }
        const value = candidate as { address: string; label?: unknown; group?: unknown };
        const address = new PublicKey(value.address.trim()).toBase58();
        if (addresses.has(address)) continue;
        addresses.add(address);
        imported.push({
          address,
          label: typeof value.label === 'string' ? value.label.trim().slice(0, 32) : '',
          group: value.group === 'dev' || value.group === 'bundle' || value.group === 'snipe' ? value.group : 'bundle',
        });
      }

      if (watchWallets.length + imported.length > MAX_WATCH_WALLETS) {
        setFormError(t('La importación supera el límite de {count} wallets.', { count: MAX_WATCH_WALLETS }));
        return;
      }
      if (imported.length === 0) {
        setFormError(t('El archivo no contiene wallets nuevas para importar.'));
        return;
      }
      persistWatchWallets([...watchWallets, ...imported]);
      setGroupFilter('all');
    } catch {
      setFormError(t('El JSON no es válido. Usa una exportación de Wire con direcciones públicas.'));
    } finally {
      input.value = '';
    }
  };

  const handleExportWallets = () => {
    const data = JSON.stringify({ version: 1, wallets: watchWallets.map(({ address, label, group }) => ({ address, label, group })) }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'wire-wallets-public.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section className="wire-page-section mb-12" aria-labelledby="wallet-assets-title">
      <header className="wire-page-heading">
        <div>
          <h2 id="wallet-assets-title" className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t('Activos de la wallet')}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{t('Balances confirmados en Solana Devnet. No mostramos valor en USD ni PnL.')}</p>
        </div>
      </header>

      <ProjectWalletBalances />

      <div className="wire-panel mb-4 space-y-3 p-4 sm:p-5">
        <div>
          <h3 className="font-semibold">{t('Seguimiento de wallets')}</h3>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">{t('Añade direcciones públicas para ver sus balances. La lista se guarda solo en este navegador. Para consultar balances, las direcciones se envían al RPC de Devnet configurado; nunca añadas claves privadas.')}</p>
          <p className="mt-2 text-xs text-[var(--muted)]">{t('Wallets de solo lectura guardadas: {count}/{max}', { count: visibleWatchWallets.length, max: MAX_WATCH_WALLETS })}</p>
        </div>
        <form onSubmit={handleAddWallet} className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(8rem,0.7fr)_auto] sm:items-end">
          <label className="grid gap-1.5 text-xs text-[var(--muted)]">
            {t('Nombre (opcional)')}
            <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={32} autoComplete="off" className="wire-input min-h-11 w-full" placeholder={t('Ejemplo: Trading')} />
          </label>
          <label className="grid gap-1.5 text-xs text-[var(--muted)]">
            {t('Dirección pública de Solana')}
            <input value={addressInput} onChange={(event) => setAddressInput(event.target.value)} required autoComplete="off" spellCheck={false} className="wire-input min-h-11 w-full font-mono text-xs" placeholder={t('Pega una dirección pública')} />
          </label>
          <label className="grid gap-1.5 text-xs text-[var(--muted)]">
            {t('Grupo')}
            <select value={newWalletGroup} onChange={(event) => setNewWalletGroup(event.target.value as WalletGroup)} className="wire-input min-h-11 w-full">
              {WALLET_GROUPS.map((group) => <option key={group} value={group}>{groupLabel(group, t)}</option>)}
            </select>
          </label>
          <button type="submit" disabled={!storageReady || watchWallets.length >= MAX_WATCH_WALLETS} className="wire-button wire-button-primary min-h-11">
            <Plus size={15} aria-hidden="true" />{t('Añadir wallet')}
          </button>
        </form>
        {formError && <p className="text-sm text-[var(--danger,#ff8b8b)]" role="alert">{formError}</p>}
        <p className="text-xs leading-relaxed text-[var(--muted)]">{t('La importación y exportación incluyen solo direcciones públicas, nombres y grupos; nunca claves privadas.')}</p>
        <div className="flex flex-wrap gap-2">
          <input ref={importInputRef} type="file" accept=".json,application/json" onChange={handleImportWallets} className="sr-only" aria-label={t('Importar wallets públicas desde JSON')} />
          <button type="button" onClick={() => importInputRef.current?.click()} disabled={!storageReady || watchWallets.length >= MAX_WATCH_WALLETS} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
            {t('Importar JSON')}
          </button>
          <button type="button" onClick={handleExportWallets} disabled={!watchWallets.length} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
            {t('Exportar JSON')}
          </button>
        </div>
      </div>

      {totalWalletCount > 0 && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-medium text-[var(--muted)]">{t('Filtrar por grupo')}</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('Filtrar por grupo')}>
            <button type="button" onClick={() => setGroupFilter('all')} aria-pressed={groupFilter === 'all'} className={`wire-button min-h-11 px-3 text-xs ${groupFilter === 'all' ? 'wire-button-primary' : 'wire-button-secondary'}`}>
              {t('Todos')} <span className="ml-1 tabular-nums">{totalWalletCount}</span>
            </button>
            {WALLET_GROUPS.map((group) => (
              <button key={group} type="button" onClick={() => setGroupFilter(group)} aria-pressed={groupFilter === group} className={`wire-button min-h-11 px-3 text-xs ${groupFilter === group ? 'wire-button-primary' : 'wire-button-secondary'}`}>
                {groupLabel(group, t)} <span className="ml-1 tabular-nums">{groupCounts[group]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {showConnectedWallet && <WalletAssetCard key={`connected-${connectedAddress}`} address={connectedAddress} label={t('Wallet conectada')} group="dev" connected />}
        {filteredWatchWallets.map((wallet) => (
          <WalletAssetCard
            key={wallet.address}
            address={wallet.address}
            label={wallet.label}
            group={wallet.group}
            connected={false}
            onRemove={() => handleRemoveWallet(wallet.address)}
            onGroupChange={(nextGroup) => persistWatchWallets(watchWallets.map((item) => item.address === wallet.address ? { ...item, group: nextGroup } : item))}
          />
        ))}
        {totalWalletCount > 0 && !showConnectedWallet && filteredWatchWallets.length === 0 && (
          <div className="wire-empty-state"><h3>{t('No hay wallets en este grupo')}</h3><p>{t('Elige otro grupo o añade una wallet a esta categoría.')}</p></div>
        )}
        {totalWalletCount === 0 && storageReady && (
          <div className="wire-empty-state">
            <h3>{t('No hay wallets en seguimiento')}</h3>
            <p>{t('Conecta una wallet o añade una dirección pública para consultar sus activos de Devnet.')}</p>
          </div>
        )}
        {!storageReady && !connectedAddress && (
          <div className="wire-empty-state" role="status" aria-live="polite">
            <span className="wire-loading-mark" aria-hidden="true" />
            <h3>{t('Cargando wallets guardadas')}</h3>
          </div>
        )}
      </div>
    </section>
  );
}
