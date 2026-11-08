'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import bs58 from 'bs58';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, Transaction } from '@solana/web3.js';
import { ArrowLeft, Flame, RefreshCw } from 'lucide-react';
import { useWireLocale } from './LocaleProvider';
import { checkPreparedBlockhash } from '../lib/blockhashPreflight';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';

type LpBalance = { lpMint: string; rawBalance: string; decimals: number };
type PreparedBurn = {
  transaction: string;
  transactionMessageHash: string;
  lastValidBlockHeight: number;
  lpMint: string;
  lpTokenAmount: string;
  decimals: number;
  sourceAccountCount: number;
  estimatedFeeLamports: number;
};
type PendingBurn = { signature: string; amountRaw: string; decimals: number; createdAt: number };

interface LpBurnPanelProps {
  poolAddress: string;
  walletAddress: string;
  vaultSigner?: { signTransaction: (transaction: Transaction) => Promise<Transaction> };
  onBack: () => void;
}

const DEVNET_RPC = 'https://api.devnet.solana.com';

function rawAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function formatRawAmount(raw: string, decimals: number, locale: 'es' | 'en') {
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const numberLocale = locale === 'es' ? 'es-419' : 'en-US';
  const wholeText = new Intl.NumberFormat(numberLocale).format(whole);
  const separator = new Intl.NumberFormat(numberLocale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return fraction ? `${wholeText}${separator}${fraction}` : wholeText;
}

async function hashMessage(transaction: Transaction) {
  const serialized = transaction.compileMessage().serialize();
  const bytes = new Uint8Array(serialized.byteLength);
  bytes.set(serialized);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storageKey(wallet: string, pool: string) {
  return `wire:lp-burn-pending:v1:${wallet}:${pool}`;
}

function readPending(raw: string | null): PendingBurn | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingBurn>;
    if (typeof value.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(value.signature)
      || typeof value.amountRaw !== 'string' || !/^[1-9]\d{0,29}$/.test(value.amountRaw)
      || !Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 18
      || !Number.isFinite(value.createdAt)) return null;
    return value as PendingBurn;
  } catch {
    return null;
  }
}

function readPendingStorage(key: string): PendingBurn | null {
  try {
    return readPending(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function clearPendingStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // The on-chain result remains authoritative even if browser storage is unavailable.
  }
}

export default function LpBurnPanel({ poolAddress, walletAddress, vaultSigner, onBack }: LpBurnPanelProps) {
  const { publicKey, signTransaction: connectedSignTransaction } = useWallet();
  const { locale, t } = useWireLocale();
  const signTransaction = vaultSigner?.signTransaction ?? connectedSignTransaction;
  const [balance, setBalance] = useState<LpBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [prepared, setPrepared] = useState<PreparedBurn | null>(null);
  const [confirmBurn, setConfirmBurn] = useState(false);
  const [pending, setPending] = useState<PendingBurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const connection = useMemo(() => new Connection(process.env.NEXT_PUBLIC_RPC_ENDPOINT || DEVNET_RPC, 'confirmed'), []);
  const pendingKey = useMemo(() => storageKey(walletAddress, poolAddress), [walletAddress, poolAddress]);

  const loadBalance = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
      const params = new URLSearchParams({ userWallet: walletAddress, poolAddress });
      const response = await fetch(`${apiUrl}/api/lp-balance?${params.toString()}`, { credentials: 'include', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success || typeof data.lpMint !== 'string'
        || typeof data.rawBalance !== 'string' || !/^\d+$/.test(data.rawBalance)
        || !Number.isInteger(data.decimals) || data.decimals < 0 || data.decimals > 18) {
        throw new Error(data.error || t('No se pudo leer el saldo LP.'));
      }
      setBalance({ lpMint: data.lpMint, rawBalance: data.rawBalance, decimals: data.decimals });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo leer el saldo LP.'));
    } finally {
      setLoading(false);
    }
  }, [poolAddress, walletAddress, t]);

  useEffect(() => { void loadBalance(); }, [loadBalance]);
  useEffect(() => { setPending(readPendingStorage(pendingKey)); }, [pendingKey]);

  const amountRaw = balance ? rawAmount(amount, balance.decimals) : null;
  const amountValid = amountRaw !== null && amountRaw > 0n && BigInt(balance?.rawBalance ?? '0') >= amountRaw;

  const verifyPending = async () => {
    if (!pending) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));
      const status = (await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })).value[0];
      if (!status) {
        setNotice(t('Aún no se encuentra la firma en Devnet. Revisa Explorer antes de preparar otra quema.'));
      } else if (status.err) {
        clearPendingStorage(pendingKey);
        setPending(null);
        setPrepared(null);
        setError(t('Solana rechazó la quema; la transacción no modificó los LP. Revisa Explorer y actualiza el saldo antes de preparar otra.'));
      } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        clearPendingStorage(pendingKey);
        setPending(null);
        setPrepared(null);
        setConfirmBurn(false);
        setNotice(t('Quema de LP confirmada en Devnet.'));
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
        await loadBalance();
      } else {
        setNotice(t('La firma sigue pendiente en Devnet. No vuelvas a enviar esta quema.'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo verificar la firma.'));
    } finally {
      setBusy(false);
    }
  };

  const prepareBurn = async () => {
    if (!balance || !amountValid || amountRaw === null || pending) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!publicKey && !vaultSigner) throw new Error(t('Conecta o desbloquea la wallet seleccionada para firmar.'));
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/prepare-lp-burn`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userWallet: walletAddress, poolAddress, lpTokenAmount: amountRaw.toString() }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || t('No se pudo preparar la quema de LP.'));
      if (data.poolAddress !== poolAddress || data.lpMint !== balance.lpMint || data.lpTokenAmount !== amountRaw.toString()
        || !Number.isSafeInteger(data.lastValidBlockHeight) || typeof data.transaction !== 'string'
        || typeof data.transactionMessageHash !== 'string' || data.decimals !== balance.decimals
        || !Number.isInteger(data.sourceAccountCount) || data.sourceAccountCount < 1) {
        throw new Error(t('La revisión recibida no coincide con esta pool y esta cantidad. No se solicitó ninguna firma.'));
      }
      const tx = Transaction.from(Buffer.from(data.transaction, 'base64'));
      if (!tx.feePayer?.toBase58() || tx.feePayer.toBase58() !== walletAddress || !tx.recentBlockhash
        || await hashMessage(tx) !== data.transactionMessageHash) {
        throw new Error(t('La transacción preparada no coincide con esta wallet. No se solicitó ninguna firma.'));
      }
      const blockhashState = await checkPreparedBlockhash(connection, tx.recentBlockhash, data.lastValidBlockHeight);
      if (blockhashState !== 'valid') throw new Error(t('La revisión venció o no pertenece a Devnet. Prepara una revisión nueva.'));
      const feeQuote = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
      if (feeQuote.value === null || !Number.isSafeInteger(feeQuote.value) || feeQuote.value < 0) {
        throw new Error(t('No se pudo estimar la tarifa de red en Devnet. No se solicitó ninguna firma.'));
      }
      setPrepared({
        transaction: data.transaction,
        transactionMessageHash: data.transactionMessageHash,
        lastValidBlockHeight: data.lastValidBlockHeight,
        lpMint: data.lpMint,
        lpTokenAmount: data.lpTokenAmount,
        decimals: data.decimals,
        sourceAccountCount: data.sourceAccountCount,
        estimatedFeeLamports: feeQuote.value,
      });
      setConfirmBurn(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo preparar la quema de LP.'));
    } finally {
      setBusy(false);
    }
  };

  const signAndBurn = async () => {
    if (!prepared || !confirmBurn || !signTransaction || pending) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));
      const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'));
      if (!tx.recentBlockhash || await hashMessage(tx) !== prepared.transactionMessageHash) {
        throw new Error(t('La revisión cambió. Prepara una quema nueva.'));
      }
      const blockhashState = await checkPreparedBlockhash(connection, tx.recentBlockhash, prepared.lastValidBlockHeight);
      if (blockhashState !== 'valid') throw new Error(t('La revisión venció. Prepara una quema nueva; no se solicitó la firma.'));

      try {
        window.localStorage.setItem(pendingKey, 'wire-storage-check');
        window.localStorage.removeItem(pendingKey);
      } catch {
        throw new Error(t('Este navegador no permite guardar la firma pendiente de forma segura. Habilita el almacenamiento local antes de firmar.'));
      }

      const signed = await signTransaction(tx);
      if (await hashMessage(signed) !== prepared.transactionMessageHash) {
        throw new Error(t('La wallet modificó la transacción. No se enviará la quema.'));
      }
      const walletSignature = signed.signatures.find((item) => item.publicKey.toBase58() === walletAddress)?.signature;
      if (!walletSignature) throw new Error(t('La wallet no firmó la quema.'));
      const signature = bs58.encode(walletSignature);
      const pendingRecord: PendingBurn = {
        signature,
        amountRaw: prepared.lpTokenAmount,
        decimals: prepared.decimals,
        createdAt: Date.now(),
      };
      try {
        window.localStorage.setItem(pendingKey, JSON.stringify(pendingRecord));
      } catch {
        throw new Error(t('No se pudo guardar el estado de la firma. La transacción no se enviará.'));
      }
      setPending(pendingRecord);

      const sentSignature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
      if (sentSignature !== signature) throw new Error(t('La RPC devolvió otra firma. No reenvíes la quema; comprueba ambas firmas.'));
      const confirmation = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(t('Solana devolvió un error. Comprueba la firma en Explorer antes de repetir la acción.'));
      clearPendingStorage(pendingKey);
      setPending(null);
      setPrepared(null);
      setConfirmBurn(false);
      setAmount('');
      setNotice(t('Quema de LP confirmada en Devnet.'));
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      await loadBalance();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo confirmar la quema de LP.'));
    } finally {
      setBusy(false);
    }
  };

  const explorerUrl = pending ? `https://explorer.solana.com/tx/${pending.signature}?cluster=devnet` : null;

  return (
    <section className="wire-panel mx-auto mt-6 max-w-3xl space-y-5 p-4 sm:p-6" aria-labelledby="lp-burn-title">
      <button type="button" onClick={onBack} disabled={busy} className="wire-button wire-button-quiet min-h-11 px-3"><ArrowLeft size={16} aria-hidden="true" />{t('Volver a pools')}</button>
      <header>
        <p className="wire-kicker mb-2">SOLANA · DEVNET</p>
        <h2 id="lp-burn-title" className="font-display text-2xl font-semibold">{t('Quema de tokens LP')}</h2>
        <p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">{poolAddress}</p>
      </header>

      <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
        <h3 className="font-semibold">{t('Qué hace esta acción')}</h3>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{t('Quemar LP destruye de forma permanente la cantidad indicada de tokens LP de esta wallet. No retira liquidez, no devuelve los activos del pool y no se puede deshacer. Para recuperar activos, usa Retirar liquidez.')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] p-4">
        <div>
          <p className="text-xs text-[var(--muted)]">{t('Saldo LP disponible')}</p>
          <p className="mt-1 font-mono text-lg font-semibold">{loading ? t('Cargando…') : balance ? formatRawAmount(balance.rawBalance, balance.decimals, locale) : '—'}</p>
          {balance && <code className="mt-1 block break-all text-xs text-[var(--muted)]">{balance.lpMint}</code>}
        </div>
        <button type="button" onClick={() => void loadBalance()} disabled={loading || busy} className="wire-button wire-button-secondary min-h-11 px-3"><RefreshCw size={15} aria-hidden="true" />{t('Actualizar saldo')}</button>
      </div>

      {!pending && balance && BigInt(balance.rawBalance) > 0n && !prepared && (
        <div className="space-y-3">
          <label htmlFor="lp-burn-amount" className="block text-sm font-medium">{t('Cantidad de LP que quieres quemar')}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input id="lp-burn-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} className="wire-input min-h-11 min-w-0 flex-1 font-mono" placeholder="0.0" aria-describedby="lp-burn-amount-help" />
            <button type="button" onClick={() => setAmount(formatRawAmount(balance.rawBalance, balance.decimals, 'en'))} className="wire-button wire-button-secondary min-h-11 px-4">{t('Usar todo')}</button>
          </div>
          <p id="lp-burn-amount-help" className="text-xs text-[var(--muted)]">{t('La cantidad se comprueba con el saldo on-chain antes de preparar la transacción.')}</p>
          <button type="button" onClick={() => void prepareBurn()} disabled={!amountValid || busy || loading} className="wire-button wire-button-primary min-h-11 w-full justify-center"><Flame size={16} aria-hidden="true" />{busy ? t('Preparando revisión…') : t('Revisar quema')}</button>
        </div>
      )}

      {prepared && !pending && (
        <div className="space-y-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <h3 className="font-semibold">{t('Revisa antes de firmar')}</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-[var(--muted)]">{t('Wallet')}</dt><dd className="break-all font-mono text-xs">{walletAddress}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Pool')}</dt><dd className="break-all font-mono text-xs">{poolAddress}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('LP que se quemarán')}</dt><dd className="font-mono">{formatRawAmount(prepared.lpTokenAmount, prepared.decimals, locale)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Cuentas LP usadas')}</dt><dd>{prepared.sourceAccountCount}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Tarifa de red estimada')}</dt><dd className="font-mono">{formatRawAmount(String(prepared.estimatedFeeLamports), 9, locale)} SOL</dd></div>
          </dl>
          <p className="text-xs leading-relaxed text-[var(--muted)]">{t('La wallet seleccionada paga la tarifa de red. Solana confirma el costo final al ejecutar la transacción.')}</p>
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
            <input type="checkbox" checked={confirmBurn} onChange={(event) => setConfirmBurn(event.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--wire-green)]" />
            <span>{t('Entiendo que esta cantidad de LP se destruirá permanentemente y que esta acción no retira los activos del pool.')}</span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => { setPrepared(null); setConfirmBurn(false); }} disabled={busy} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{t('Cancelar')}</button>
            <button type="button" onClick={() => void signAndBurn()} disabled={!confirmBurn || busy} className="wire-button min-h-11 flex-1 justify-center border border-[var(--danger)] bg-[var(--danger)] text-[#1b0909]">{busy ? t('Esperando confirmación…') : t('Firmar y quemar LP')}</button>
          </div>
        </div>
      )}

      {pending && (
        <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" role="status">
          <h3 className="font-semibold">{t('Firma pendiente de verificar')}</h3>
          <p className="text-sm text-[var(--muted)]">{t('No prepares otra quema hasta comprobar esta firma. Si se confirma, los LP ya no se podrán recuperar.')}</p>
          <code className="block break-all font-mono text-xs">{pending.signature}</code>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => void verifyPending()} disabled={busy} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{busy ? t('Comprobando…') : t('Verificar en Devnet')}</button>
            <a href={explorerUrl ?? '#'} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{t('Ver en Explorer')}</a>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}
      {notice && <p className="text-sm text-[var(--success)]" role="status">{notice}</p>}
      {balance && BigInt(balance.rawBalance) === 0n && !loading && <p className="rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--muted)]">{t('Esta wallet no tiene saldo LP para quemar.')}</p>}
    </section>
  );
}
