'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import bs58 from 'bs58';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, Transaction } from '@solana/web3.js';
import { ArrowLeft, LockKeyhole, RefreshCw } from 'lucide-react';
import { useWireLocale } from './LocaleProvider';
import { checkPreparedBlockhash } from '../lib/blockhashPreflight';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';

type LpBalance = { lpMint: string; rawBalance: string; canonicalRawBalance: string; decimals: number };
type PreparedLock = {
  transaction: string;
  transactionMessageHash: string;
  lastValidBlockHeight: number;
  poolAddress: string;
  lpMint: string;
  lpTokenAmount: string;
  availableLpAmount: string;
  decimals: number;
  metadataAddress: string;
  escrowAddress: string;
  sourceAccount: string;
  treasuryTokenAddress: string;
  unlockAt: string;
  unlockTimestamp: number;
  lockDurationDays: number;
  estimatedNetworkFeeLamports: number;
  estimatedWalletSolDeltaLamports: number;
  streamflowCreationFeeLamports: number;
  streamflowTokenFeePercent: number;
  streamflowTokenFeeRaw: string;
  feeQuoteWallet: string;
  feeQuotedAt: number;
};
type PendingLock = { signature: string; amountRaw: string; decimals: number; unlockAt: string; metadataAddress: string; lastValidBlockHeight: number; createdAt: number; status?: 'pending' | 'confirmed' };

interface LpLockPanelProps {
  poolAddress: string;
  walletAddress: string;
  vaultSigner?: { signTransaction: (transaction: Transaction) => Promise<Transaction> };
  onBack: () => void;
}

const DEVNET_RPC = 'https://api.devnet.solana.com';
const STREAMFLOW_PROGRAM = 'HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ';
const STREAMFLOW_TREASURY = '5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw';
const STREAMFLOW_WITHDRAWOR = 'wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u';
const STREAMFLOW_FEE_ORACLE = 'Aa2JJfFzUN3V54DXUHRBJowFw416xfZHpPk9DaNy3iYs';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

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

function formatSol(lamports: number, locale: 'es' | 'en') {
  return `${formatRawAmount(String(lamports), 9, locale)} SOL`;
}

async function hashMessage(transaction: Transaction) {
  const serialized = transaction.compileMessage().serialize();
  const bytes = new Uint8Array(serialized.byteLength);
  bytes.set(serialized);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storageKey(wallet: string, pool: string) {
  return `wire:lp-lock-pending:v1:${wallet}:${pool}`;
}

function readPending(raw: string | null): PendingLock | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingLock>;
    if (typeof value.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(value.signature)
      || typeof value.amountRaw !== 'string' || !/^\d{1,30}$/.test(value.amountRaw)
      || !Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 18
      || typeof value.unlockAt !== 'string' || !Number.isFinite(Date.parse(value.unlockAt))
      || typeof value.metadataAddress !== 'string' || !Number.isSafeInteger(value.lastValidBlockHeight)
      || !Number.isFinite(value.createdAt)) return null;
    return value as PendingLock;
  } catch {
    return null;
  }
}

function readPendingStorage(key: string): PendingLock | null {
  try { return readPending(window.localStorage.getItem(key)); } catch { return null; }
}

function clearPendingStorage(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* Chain state remains authoritative. */ }
}

function assertLockTransaction(transaction: Transaction, prepared: PreparedLock, walletAddress: string) {
  if (transaction.instructions.length !== 1) throw new Error('La transacción contiene instrucciones inesperadas. No se solicitó la firma.');
  const instruction = transaction.instructions[0];
  const keys = instruction.keys.map((meta) => meta.pubkey.toBase58());
  if (instruction.programId.toBase58() !== STREAMFLOW_PROGRAM || keys.length !== 18
    || keys[0] !== walletAddress || keys[1] !== prepared.sourceAccount || keys[2] !== walletAddress
    || keys[3] !== prepared.metadataAddress || keys[4] !== prepared.escrowAddress || keys[5] !== prepared.sourceAccount
    || keys[6] !== STREAMFLOW_TREASURY || keys[7] !== prepared.treasuryTokenAddress
    || keys[8] !== STREAMFLOW_WITHDRAWOR || keys[9] !== STREAMFLOW_TREASURY || keys[10] !== prepared.treasuryTokenAddress
    || keys[11] !== prepared.lpMint || keys[12] !== STREAMFLOW_FEE_ORACLE || keys[13] !== RENT_SYSVAR || keys[14] !== STREAMFLOW_PROGRAM
    || keys[15] !== TOKEN_PROGRAM || keys[16] !== ASSOCIATED_TOKEN_PROGRAM || keys[17] !== SYSTEM_PROGRAM) {
    throw new Error('La transacción no coincide con la wallet, los LP y el bloqueo revisados. No se solicitó la firma.');
  }
  if (!instruction.keys[0].isSigner || instruction.keys.slice(1).some((meta) => meta.isSigner)
    || instruction.keys.slice(0, 11).some((meta) => !meta.isWritable)
    || instruction.keys.slice(11).some((meta) => meta.isWritable)) {
    throw new Error('Los permisos de las cuentas de Streamflow no coinciden con la revisión. No se solicitó la firma.');
  }
  const data = Buffer.from(instruction.data);
  const lockName = Buffer.from('Wire LP lock 180 days', 'utf8');
  if (data.length !== 140 || data.subarray(0, 8).toString('hex') !== 'd6904cec5f8b31b4'
    || data.readBigUInt64LE(8) !== BigInt(prepared.unlockTimestamp)
    || data.readBigUInt64LE(16) !== BigInt(prepared.lpTokenAmount)
    || data.readBigUInt64LE(40) !== BigInt(prepared.unlockTimestamp)
    || data.readBigUInt64LE(48) !== BigInt(prepared.lpTokenAmount) - 1n
    || !data.subarray(56, 62).every((byte) => byte === 0)
    || !data.subarray(62, 62 + lockName.length).equals(lockName)) {
    throw new Error('El plazo o la cantidad del mensaje no coinciden con la revisión. No se solicitó la firma.');
  }
}

export default function LpLockPanel({ poolAddress, walletAddress, vaultSigner, onBack }: LpLockPanelProps) {
  const { publicKey, signTransaction: connectedSignTransaction } = useWallet();
  const { locale, t } = useWireLocale();
  const signTransaction = vaultSigner?.signTransaction ?? connectedSignTransaction;
  const [balance, setBalance] = useState<LpBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [prepared, setPrepared] = useState<PreparedLock | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const [pending, setPending] = useState<PendingLock | null>(null);
  const [completedLock, setCompletedLock] = useState<PendingLock | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const connection = useMemo(() => new Connection(process.env.NEXT_PUBLIC_RPC_ENDPOINT || DEVNET_RPC, 'confirmed'), []);
  const pendingKey = useMemo(() => storageKey(walletAddress, poolAddress), [walletAddress, poolAddress]);

  const loadBalance = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ userWallet: walletAddress, poolAddress });
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/lp-balance?${params.toString()}`, { credentials: 'include', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success || typeof data.lpMint !== 'string'
        || typeof data.canonicalRawBalance !== 'string' || !/^\d+$/.test(data.canonicalRawBalance)
        || !Number.isInteger(data.decimals) || data.decimals < 0 || data.decimals > 18) {
        throw new Error(data.error || t('No se pudo leer el saldo LP canónico.'));
      }
      setBalance({ lpMint: data.lpMint, rawBalance: data.rawBalance, canonicalRawBalance: data.canonicalRawBalance, decimals: data.decimals });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo leer el saldo LP canónico.'));
    } finally {
      setLoading(false);
    }
  }, [poolAddress, walletAddress, t]);

  useEffect(() => { void loadBalance(); }, [loadBalance]);
  useEffect(() => {
    const saved = readPendingStorage(pendingKey);
    if (saved?.status === 'confirmed') {
      setPending(null);
      setCompletedLock(saved);
    } else {
      setPending(saved);
      setCompletedLock(null);
    }
  }, [pendingKey]);

  const amountRaw = balance ? rawAmount(amount, balance.decimals) : null;
  const available = BigInt(balance?.canonicalRawBalance ?? '0');
  const amountValid = amountRaw !== null && amountRaw > 1n && available >= amountRaw;

  const verifyPending = async () => {
    if (!pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));
      const status = (await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })).value[0];
      if (!status) {
        const currentBlockHeight = await connection.getBlockHeight('confirmed');
        if (currentBlockHeight > pending.lastValidBlockHeight) {
          clearPendingStorage(pendingKey); setPending(null);
          setNotice(t('La firma no apareció y su blockhash venció en Devnet. Ya puedes actualizar el saldo y preparar otra revisión.'));
          await loadBalance();
        } else setNotice(t('Aún no se encuentra la firma en Devnet. Comprueba Explorer antes de preparar otro bloqueo.'));
      }
      else if (status.err) {
        clearPendingStorage(pendingKey); setPending(null); setPrepared(null);
        await loadBalance();
        setError(t('Devnet rechazó el bloqueo; actualiza el saldo antes de volver a prepararlo.'));
      } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        const completed = { ...pending, status: 'confirmed' as const };
        try { window.localStorage.setItem(pendingKey, JSON.stringify(completed)); } catch { /* Keep current screen state. */ }
        setPending(null); setCompletedLock(completed); setPrepared(null); setConfirmLock(false);
        setNotice(t('Bloqueo LP confirmado en Devnet. Guarda la fecha de desbloqueo y revisa el estado del stream en Streamflow.'));
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
        await loadBalance();
      } else setNotice(t('La firma sigue pendiente en Devnet. No vuelvas a enviar este bloqueo.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo verificar la firma.'));
    } finally { setBusy(false); }
  };

  const prepareLock = async () => {
    if (!balance || !amountValid || amountRaw === null || pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!vaultSigner && (!publicKey || publicKey.toBase58() !== walletAddress)) throw new Error(t('Conecta la wallet seleccionada o desbloquea la bóveda para firmar.'));
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/prepare-lp-lock`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userWallet: walletAddress, poolAddress, lpTokenAmount: amountRaw.toString() }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || t('No se pudo preparar el bloqueo LP.'));
      const fieldsValid = data.poolAddress === poolAddress && data.lpMint === balance.lpMint
        && data.lpTokenAmount === amountRaw.toString() && typeof data.availableLpAmount === 'string'
        && /^\d+$/.test(data.availableLpAmount) && BigInt(data.availableLpAmount) >= amountRaw
        && data.decimals === balance.decimals && data.lockDurationDays === 180
        && Number.isSafeInteger(data.unlockTimestamp) && typeof data.unlockAt === 'string'
        && Math.floor(Date.parse(data.unlockAt) / 1000) === data.unlockTimestamp
        && Number.isSafeInteger(data.lastValidBlockHeight) && typeof data.transaction === 'string'
        && typeof data.transactionMessageHash === 'string' && typeof data.metadataAddress === 'string'
        && typeof data.escrowAddress === 'string' && typeof data.sourceAccount === 'string'
        && typeof data.treasuryTokenAddress === 'string'
        && Number.isSafeInteger(data.estimatedNetworkFeeLamports) && data.estimatedNetworkFeeLamports >= 0
        && Number.isSafeInteger(data.estimatedWalletSolDeltaLamports) && data.estimatedWalletSolDeltaLamports >= 0
        && Number.isSafeInteger(data.streamflowCreationFeeLamports) && data.streamflowCreationFeeLamports >= 0
        && Number.isFinite(data.streamflowTokenFeePercent) && data.streamflowTokenFeePercent >= 0 && data.streamflowTokenFeePercent <= 100
        && typeof data.streamflowTokenFeeRaw === 'string' && /^\d+$/.test(data.streamflowTokenFeeRaw)
        && typeof data.feeQuoteWallet === 'string' && Number.isFinite(data.feeQuotedAt);
      if (!fieldsValid) throw new Error(t('La revisión recibida no coincide con esta pool, wallet o cantidad. No se solicitó ninguna firma.'));
      const tx = Transaction.from(Buffer.from(data.transaction, 'base64'));
      if (tx.feePayer?.toBase58() !== walletAddress || !tx.recentBlockhash) throw new Error(t('La transacción preparada no coincide con esta wallet. No se solicitó ninguna firma.'));
      const nextPrepared = data as PreparedLock;
      assertLockTransaction(tx, nextPrepared, walletAddress);
      if (await hashMessage(tx) !== nextPrepared.transactionMessageHash) throw new Error(t('El mensaje preparado cambió. No se solicitó ninguna firma.'));
      if (await checkPreparedBlockhash(connection, tx.recentBlockhash, nextPrepared.lastValidBlockHeight) !== 'valid') {
        throw new Error(t('La revisión venció o no pertenece a Devnet. Prepara un bloqueo nuevo.'));
      }
      const fee = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
      if (fee.value === null || fee.value !== nextPrepared.estimatedNetworkFeeLamports) throw new Error(t('La tarifa de red cambió. Prepara una revisión nueva.'));
      setPrepared(nextPrepared); setConfirmLock(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo preparar el bloqueo LP.'));
    } finally { setBusy(false); }
  };

  const signAndLock = async () => {
    if (!prepared || !confirmLock || !signTransaction || pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));
      const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'));
      assertLockTransaction(tx, prepared, walletAddress);
      if (!tx.recentBlockhash || await hashMessage(tx) !== prepared.transactionMessageHash) throw new Error(t('La revisión cambió. Prepara un bloqueo nuevo.'));
      if (Date.now() - prepared.feeQuotedAt > 60_000) throw new Error(t('La cotización de Streamflow venció. Prepara una revisión nueva.'));
      if (await checkPreparedBlockhash(connection, tx.recentBlockhash, prepared.lastValidBlockHeight) !== 'valid') throw new Error(t('La revisión venció. Prepara un bloqueo nuevo; no se solicitó la firma.'));
      try { window.localStorage.setItem(pendingKey, 'wire-storage-check'); window.localStorage.removeItem(pendingKey); }
      catch { throw new Error(t('Este navegador no permite guardar el estado pendiente. Habilita el almacenamiento local antes de firmar.')); }

      const signed = await signTransaction(tx);
      if (await hashMessage(signed) !== prepared.transactionMessageHash) throw new Error(t('La wallet modificó la transacción. No se enviará el bloqueo.'));
      const walletSignature = signed.signatures.find((item) => item.publicKey.toBase58() === walletAddress)?.signature;
      if (!walletSignature) throw new Error(t('La wallet no firmó el bloqueo.'));
      const record: PendingLock = {
        signature: bs58.encode(walletSignature), amountRaw: prepared.lpTokenAmount,
        decimals: prepared.decimals, unlockAt: prepared.unlockAt,
        metadataAddress: prepared.metadataAddress, lastValidBlockHeight: prepared.lastValidBlockHeight, createdAt: Date.now(),
      };
      try { window.localStorage.setItem(pendingKey, JSON.stringify(record)); }
      catch { throw new Error(t('No se pudo guardar el estado de la firma. La transacción no se enviará.')); }
      setPending(record);
      const sentSignature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
      if (sentSignature !== record.signature) throw new Error(t('La RPC devolvió otra firma. Comprueba ambas en Explorer y no reenvíes el bloqueo.'));
      const confirmation = await connection.confirmTransaction({ signature: record.signature, blockhash: tx.recentBlockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(t('Devnet devolvió un error. Comprueba la firma en Explorer antes de repetir la acción.'));
      const completed = { ...record, status: 'confirmed' as const };
      try { window.localStorage.setItem(pendingKey, JSON.stringify(completed)); } catch { /* Keep current screen state. */ }
      setPending(null); setCompletedLock(completed); setPrepared(null); setConfirmLock(false); setAmount('');
      setNotice(t('Bloqueo LP confirmado en Devnet. Guarda la fecha de desbloqueo y revisa el estado del stream en Streamflow.'));
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      await loadBalance();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('No se pudo confirmar el bloqueo LP.'));
    } finally { setBusy(false); }
  };

  const explorerUrl = pending ? `https://explorer.solana.com/tx/${pending.signature}?cluster=devnet` : null;
  const unlockDate = (value: string) => new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';

  return (
    <section className="wire-panel mx-auto mt-6 max-w-3xl space-y-5 p-4 sm:p-6" aria-labelledby="lp-lock-title">
      <button type="button" onClick={onBack} disabled={busy} className="wire-button wire-button-quiet min-h-11 px-3"><ArrowLeft size={16} aria-hidden="true" />{t('Volver a pools')}</button>
      <header>
        <h2 id="lp-lock-title" className="font-display text-2xl font-semibold">{t('Bloqueo temporal de LP')}</h2>
        <p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">{poolAddress}</p>
      </header>

      <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
        <h3 className="font-semibold">{t('Cómo funciona este bloqueo')}</h3>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{t('Streamflow mantendrá los LP en un escrow hasta la fecha indicada. Antes no podrás retirarlos, cancelar el stream ni usarlos para retirar liquidez. Al vencer, la wallet podrá reclamar los LP desde Streamflow; Wire no controla el escrow ni puede acelerar la fecha.')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] p-4">
        <div>
          <p className="text-xs text-[var(--muted)]">{t('Saldo LP disponible en la cuenta canónica')}</p>
          <p className="mt-1 font-mono text-lg font-semibold">{loading ? t('Cargando…') : balance ? formatRawAmount(balance.canonicalRawBalance, balance.decimals, locale) : '—'}</p>
          {balance && <code className="mt-1 block break-all text-xs text-[var(--muted)]">{balance.lpMint}</code>}
        </div>
        <button type="button" onClick={() => void loadBalance()} disabled={loading || busy} className="wire-button wire-button-secondary min-h-11 px-3"><RefreshCw size={15} aria-hidden="true" />{t('Actualizar saldo')}</button>
      </div>

      {!pending && balance && available > 0n && !prepared && (
        <div className="space-y-3">
          <label htmlFor="lp-lock-amount" className="block text-sm font-medium">{t('Cantidad de LP que quieres bloquear')}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input id="lp-lock-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} className="wire-input min-h-11 min-w-0 flex-1 font-mono" placeholder="0.0" aria-describedby="lp-lock-amount-help" />
            <button type="button" onClick={() => setAmount(formatRawAmount(balance.canonicalRawBalance, balance.decimals, 'en'))} className="wire-button wire-button-secondary min-h-11 px-4">{t('Usar todo')}</button>
          </div>
          <p id="lp-lock-amount-help" className="text-xs text-[var(--muted)]">{t('El bloqueo dura 180 días. Streamflow requiere LP en la cuenta canónica SPL clásica; se mostrará el fee vigente de Devnet antes de firmar.')}</p>
          <button type="button" onClick={() => void prepareLock()} disabled={!amountValid || busy || loading} className="wire-button wire-button-primary min-h-11 w-full justify-center"><LockKeyhole size={16} aria-hidden="true" />{busy ? t('Preparando revisión…') : t('Revisar bloqueo')}</button>
        </div>
      )}

      {prepared && !pending && (
        <div className="space-y-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <h3 className="font-semibold">{t('Revisa antes de firmar')}</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-[var(--muted)]">{t('Wallet que recuperará los LP')}</dt><dd className="break-all font-mono text-xs">{walletAddress}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('LP que se bloquearán')}</dt><dd className="font-mono">{formatRawAmount(prepared.lpTokenAmount, prepared.decimals, locale)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Fecha de desbloqueo')}</dt><dd>{unlockDate(prepared.unlockAt)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Fee de Streamflow')}</dt><dd className="font-mono">{formatRawAmount(prepared.streamflowTokenFeeRaw, prepared.decimals, locale)} LP ({prepared.streamflowTokenFeePercent.toLocaleString(locale === 'es' ? 'es-419' : 'en-US')}%)</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Cargo de creación en SOL')}</dt><dd className="font-mono">{formatSol(prepared.streamflowCreationFeeLamports, locale)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Tarifa de red estimada')}</dt><dd className="font-mono">{formatSol(prepared.estimatedNetworkFeeLamports, locale)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Salida total estimada de SOL de la wallet')}</dt><dd className="font-mono">{formatSol(prepared.estimatedWalletSolDeltaLamports, locale)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('LP netos en escrow')}</dt><dd className="font-mono">{formatRawAmount((BigInt(prepared.lpTokenAmount) - BigInt(prepared.streamflowTokenFeeRaw)).toString(), prepared.decimals, locale)}</dd></div>
          </dl>
          <p className="text-xs leading-relaxed text-[var(--muted)]">{t('El total en SOL viene de simular esta transacción exacta e incluye cuentas que se creen y renta recuperable, si aplica. La cotización de fees es de Devnet y puede cambiar antes de firmar.')}</p>
          <p className="break-all text-xs text-[var(--muted)]">{t('Dirección del stream')}: <code>{prepared.metadataAddress}</code></p>
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
            <input type="checkbox" checked={confirmLock} onChange={(event) => setConfirmLock(event.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--wire-green)]" />
            <span>{t('Entiendo que estos LP quedarán inaccesibles durante 180 días, que Streamflow cobra las tarifas mostradas y que debo reclamarlos desde Streamflow al vencer.')}</span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => { setPrepared(null); setConfirmLock(false); }} disabled={busy} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{t('Cancelar')}</button>
            <button type="button" onClick={() => void signAndLock()} disabled={!confirmLock || busy} className="wire-button wire-button-primary min-h-11 flex-1 justify-center">{busy ? t('Esperando confirmación…') : t('Firmar y bloquear LP')}</button>
          </div>
        </div>
      )}

      {pending && (
        <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" role="status">
          <h3 className="font-semibold">{t('Firma pendiente de verificar')}</h3>
          <p className="text-sm text-[var(--muted)]">{t('No prepares otro bloqueo hasta comprobar esta firma. La transacción pudo llegar a Devnet aunque la interfaz haya perdido la conexión.')}</p>
          <p className="text-sm">{t('Cantidad')}: <span className="font-mono">{formatRawAmount(pending.amountRaw, pending.decimals, locale)}</span> · {t('Desbloqueo')}: {unlockDate(pending.unlockAt)}</p>
          <code className="block break-all font-mono text-xs">{pending.signature}</code>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => void verifyPending()} disabled={busy} className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{busy ? t('Comprobando…') : t('Verificar en Devnet')}</button>
            <a href={explorerUrl ?? '#'} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{t('Ver en Explorer')}</a>
          </div>
        </div>
      )}

      {completedLock && (
        <div className="space-y-3 rounded-xl border border-[var(--line)] p-4" role="status">
          <h3 className="font-semibold">{t('Último bloqueo confirmado')}</h3>
          <p className="text-sm text-[var(--muted)]">{t('Guarda esta fecha. Al vencer, conecta la misma wallet en Streamflow para reclamar los LP.')}</p>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-[var(--muted)]">{t('Cantidad')}</dt><dd className="font-mono">{formatRawAmount(completedLock.amountRaw, completedLock.decimals, locale)}</dd></div>
            <div><dt className="text-[var(--muted)]">{t('Fecha de desbloqueo')}</dt><dd>{unlockDate(completedLock.unlockAt)}</dd></div>
          </dl>
          <code className="block break-all font-mono text-xs">{completedLock.metadataAddress}</code>
          <div className="flex flex-col gap-2 sm:flex-row">
            <a href={`https://explorer.solana.com/address/${completedLock.metadataAddress}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{t('Ver stream en Explorer')}</a>
            <a href={`https://explorer.solana.com/tx/${completedLock.signature}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 flex-1 justify-center">{t('Ver en Explorer')}</a>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}
      {notice && <p className="text-sm text-[var(--success)]" role="status">{notice}</p>}
      {balance && available === 0n && !loading && <p className="rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--muted)]">{t('Esta wallet no tiene saldo LP en su cuenta canónica para bloquear.')}</p>}
    </section>
  );
}
