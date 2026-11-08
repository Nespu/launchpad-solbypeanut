'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction, Connection } from '@solana/web3.js';
import { ArrowRight, Check, ExternalLink, X } from 'lucide-react';
import { notifyToast, userFacingError } from './toastEvents';
import { useWireLocale } from './LocaleProvider';
import {
  clearStoredFullPoolWithdrawal,
  hasStoredFullPoolWithdrawal,
  markStoredTokenCreationPoolWithdrawn,
} from '../lib/tokenCreationStorage';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';

interface WithdrawLiquidityProps {
  poolAddress: string;
  tokenMintAddress: string;
  quoteMint: string;
  vaultSigner?: {
    address: string;
    label: string;
    signTransaction: (transaction: Transaction) => Promise<Transaction>;
  };
  onBack: () => void;
}

type PreparedWithdrawal = {
  withdrawalId: string;
  transaction: string;
  transactionMessageHash: string;
  lastValidBlockHeight: number;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteAmountRaw: string;
  minimumQuoteOutRaw: string;
  platformFeeRaw: string;
  tokenOutAmount: string;
  minimumTokenOutAmount: string;
  tokenSymbol: string;
};

function formatRawAssetAmount(rawAmount: string, decimals: number, locale: 'es' | 'en') {
  const raw = BigInt(rawAmount);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const numberLocale = locale === 'es' ? 'es-419' : 'en-US';
  const wholeText = new Intl.NumberFormat(numberLocale).format(whole);
  const decimal = new Intl.NumberFormat(numberLocale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return fraction ? `${wholeText}${decimal}${fraction}` : wholeText;
}

async function hashTransactionMessage(transaction: Transaction): Promise<string> {
  const bytes = Uint8Array.from(transaction.compileMessage().serialize());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function changedTransactionParts(before: Transaction, after: Transaction): string[] {
  const a = before.compileMessage();
  const b = after.compileMessage();
  const changes: string[] = [];
  const computeBudgetProgram = 'ComputeBudget111111111111111111111111111111';
  const instructionKey = (message: ReturnType<Transaction['compileMessage']>, instruction: (typeof message.instructions)[number]) =>
    `${message.accountKeys[instruction.programIdIndex]?.toBase58()}:${instruction.accounts.join(',')}:${Buffer.from(instruction.data).toString('hex')}`;
  if (a.accountKeys[0]?.toBase58() !== b.accountKeys[0]?.toBase58()) changes.push('wallet pagadora');
  if (a.recentBlockhash !== b.recentBlockhash) changes.push('blockhash');
  if (a.accountKeys.map((key) => key.toBase58()).join('|') !== b.accountKeys.map((key) => key.toBase58()).join('|')) changes.push('cuentas');
  if (a.instructions.length !== b.instructions.length) {
    let unmatched = [...b.instructions];
    for (const instruction of a.instructions) {
      const key = instructionKey(a, instruction);
      const matchIndex = unmatched.findIndex((candidate) => instructionKey(b, candidate) === key);
      if (matchIndex >= 0) unmatched.splice(matchIndex, 1);
    }
    const added = unmatched.map((instruction) => {
      const programId = b.accountKeys[instruction.programIdIndex]?.toBase58();
      if (programId === computeBudgetProgram) {
        return 'instrucción de Compute Budget';
      }
      return `instrucción del programa ${programId ?? 'desconocido'}`;
    });
    changes.push(added.length ? `instrucción(es) añadida(s): ${added.join(', ')}` : 'cantidad de instrucciones');
  } else if (a.instructions.some((instruction, index) => instructionKey(a, instruction) !== instructionKey(b, b.instructions[index]))) {
    changes.push('contenido u orden de instrucciones');
  }
  return changes;
}

export default function WithdrawLiquidity({ poolAddress, tokenMintAddress, quoteMint, vaultSigner, onBack }: WithdrawLiquidityProps) {
  const { publicKey: connectedPublicKey, signTransaction: connectedSignTransaction } = useWallet();
  const withdrawalWalletAddress = vaultSigner?.address ?? connectedPublicKey?.toBase58() ?? null;
  const signWithdrawal = vaultSigner?.signTransaction ?? connectedSignTransaction;
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const resultDialogRef = useRef<HTMLDivElement>(null);
  const poolQuoteSymbol = quoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC';

  useEffect(() => { translateRef.current = t; }, [t]);

  const [rawBalance, setRawBalance] = useState('0');
  const [uiBalance, setUiBalance] = useState(0);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [balanceError, setBalanceError] = useState('');
  const [balanceErrorReference, setBalanceErrorReference] = useState('');
  const [fullWithdrawalRecorded, setFullWithdrawalRecorded] = useState(false);
  const [percent, setPercent] = useState(50);

  const [loading, setLoading] = useState(false);
  const [operationStage, setOperationStage] = useState<'preparing' | 'signature' | 'registering' | 'confirming' | null>(null);
  const [prepared, setPrepared] = useState<PreparedWithdrawal | null>(null);
  const [result, setResult] = useState<{
    txId: string;
    quoteSymbol: string;
    quoteDecimals: number;
    quoteAmountRaw: string;
    minimumQuoteOutRaw: string;
    platformFeeRaw: string;
    tokenOutAmount: string;
    minimumTokenOutAmount: string;
    tokenSymbol: string;
    fullWalletPosition: boolean;
  } | null>(null);

  useEffect(() => {
    if (!result) return;
    const dialog = resultDialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setResult(null);
      } else if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items[items.length - 1].focus();
        } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
          event.preventDefault();
          items[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [result]);

  // FIX (08/10): esta función se saca del useEffect para poder llamarla
  // de nuevo después de un retiro exitoso, no solo al montar el componente.
  const fetchBalance = useCallback(() => {
    if (!withdrawalWalletAddress) return;
    setLoadingBalance(true);
    setBalanceError('');
    setBalanceErrorReference('');
    return fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/lp-balance?userWallet=${encodeURIComponent(withdrawalWalletAddress)}&poolAddress=${encodeURIComponent(poolAddress)}`,
      { cache: 'no-store' },
    )
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (
          !response.ok ||
          !data?.success ||
          typeof data.rawBalance !== 'string' ||
          !/^\d+$/.test(data.rawBalance) ||
          typeof data.uiBalance !== 'number' ||
          !Number.isFinite(data.uiBalance) ||
          data.uiBalance < 0
        ) {
          if (typeof data?.errorId === 'string') setBalanceErrorReference(data.errorId);
          throw new Error(typeof data?.error === 'string' ? data.error : 'No se pudo leer el balance LP');
        }
        setRawBalance(data.rawBalance);
        setUiBalance(data.uiBalance);
        if (BigInt(data.rawBalance) > BigInt(0)) {
          clearStoredFullPoolWithdrawal(withdrawalWalletAddress, poolAddress);
          setFullWithdrawalRecorded(false);
        } else {
          setFullWithdrawalRecorded(hasStoredFullPoolWithdrawal(withdrawalWalletAddress, poolAddress));
        }
      })
      .catch((error: unknown) => {
        setBalanceError(userFacingError(
          error,
          translateRef.current('No pudimos confirmar el saldo LP. El valor no se mostrará como cero.'),
          translateRef.current,
        ));
      })
      .finally(() => setLoadingBalance(false));
  }, [withdrawalWalletAddress, poolAddress]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const rawAmountToWithdraw = (() => {
    try {
      const total = BigInt(rawBalance);
      return ((total * BigInt(percent)) / BigInt(100)).toString();
    } catch {
      return '0';
    }
  })();

  const uiAmountToWithdraw = (uiBalance * percent) / 100;
  const hasLpBalance = (() => {
    try { return BigInt(rawBalance) > BigInt(0); } catch { return false; }
  })();

  const requestPreparedWithdrawal = async (): Promise<PreparedWithdrawal> => {
    if (!withdrawalWalletAddress) throw new Error(t('Selecciona una wallet identificada para retirar liquidez.'));
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdraw-liquidity`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userWallet: withdrawalWalletAddress, poolAddress, lpTokenAmount: rawAmountToWithdraw }),
    });
    const data = await response.json();
    if (!response.ok || !data.success || typeof data.withdrawalId !== 'string' || typeof data.transaction !== 'string' || typeof data.transactionMessageHash !== 'string') {
      const requestError = new Error(data.error || 'Failed to prepare withdrawal') as Error & { errorId?: string; stage?: string };
      if (typeof data.errorId === 'string') requestError.errorId = data.errorId;
      if (typeof data.stage === 'string') requestError.stage = data.stage;
      throw requestError;
    }
    const expectedDecimals = data.quoteSymbol === 'SOL' ? 9 : data.quoteSymbol === 'USDC' ? 6 : null;
    if (expectedDecimals === null
      || data.quoteDecimals !== expectedDecimals
      || !/^\d+$/.test(String(data.quoteAmountRaw))
      || !/^\d+$/.test(String(data.minimumQuoteOutRaw))
      || !/^\d+$/.test(String(data.platformFeeRaw))) {
      throw new Error(t('El servidor devolvió importes incompletos para este retiro.'));
    }
    return {
      withdrawalId: data.withdrawalId,
      transaction: data.transaction,
      transactionMessageHash: data.transactionMessageHash,
      lastValidBlockHeight: Number(data.lastValidBlockHeight),
      quoteSymbol: String(data.quoteSymbol),
      quoteDecimals: Number(data.quoteDecimals),
      quoteAmountRaw: String(data.quoteAmountRaw),
      minimumQuoteOutRaw: String(data.minimumQuoteOutRaw),
      platformFeeRaw: String(data.platformFeeRaw),
      tokenOutAmount: String(data.tokenOutAmount),
      minimumTokenOutAmount: String(data.minimumTokenOutAmount),
      tokenSymbol: String(data.tokenSymbol),
    };
  };

  const handlePrepareWithdrawal = async () => {
    if (!withdrawalWalletAddress || !signWithdrawal) {
      notifyToast({ title: t('Selecciona una wallet'), message: t('Selecciona una wallet identificada para retirar liquidez.') });
      return;
    }
    if (rawAmountToWithdraw === '0') {
      notifyToast({ title: t('No hay saldo para retirar'), message: t('Tu saldo LP actual no permite esta operación.') });
      return;
    }

    setLoading(true);
    setOperationStage('preparing');
    try {
      setPrepared(await requestPreparedWithdrawal());
    } catch (error: any) {
      const errorId = typeof error?.errorId === 'string' ? error.errorId : null;
      const stage = typeof error?.stage === 'string' ? error.stage : null;
      const message = userFacingError(error, t('Inténtalo de nuevo.'), t);
      notifyToast({
        title: t('No se pudo preparar el retiro'),
        message: [message, stage ? `Etapa: ${stage}` : null, errorId ? `Ref. ${errorId.slice(0, 8)}` : null]
          .filter(Boolean)
          .join(' · '),
      });
    } finally {
      setLoading(false);
      setOperationStage(null);
    }
  };

  const handleCancelPreparation = async () => {
    if (!prepared) return;
    const withdrawalId = prepared.withdrawalId;
    setPrepared(null);
    if (!withdrawalWalletAddress) return;
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not cancel preparation');
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
    } catch {
      notifyToast({ title: t('No se pudo cancelar la preparación'), message: t('La preparación seguirá pendiente hasta que caduque.') });
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
    }
  };

  const handleConfirmWithdrawal = async () => {
    if (!withdrawalWalletAddress || !signWithdrawal || !prepared) return;
    setLoading(true);
    setOperationStage('signature');
    let txId: string | undefined;
    try {
      const rpcConn = new Connection(process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com');
      if (await rpcConn.getGenesisHash() !== DEVNET_GENESIS_HASH) {
        throw new Error(t('La conexión RPC no está en Solana Devnet. Cambia a Devnet y vuelve a intentar.'));
      }
      const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'));
      const preparedBlockhash = tx.recentBlockhash;
      const blockhashStatus = preparedBlockhash
        ? await rpcConn.isBlockhashValid(preparedBlockhash, { commitment: 'confirmed' })
        : { value: false };
      if (!blockhashStatus.value) {
        await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
        }).catch(() => undefined);
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
        setPrepared(null);

        setOperationStage('preparing');
        const refreshed = await requestPreparedWithdrawal();
        const refreshedTx = Transaction.from(Buffer.from(refreshed.transaction, 'base64'));
        const refreshedBlockhashStatus = refreshedTx.recentBlockhash
          ? await rpcConn.isBlockhashValid(refreshedTx.recentBlockhash, { commitment: 'confirmed' })
          : { value: false };
        if (!refreshedBlockhashStatus.value) {
          await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ withdrawalId: refreshed.withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
          }).catch(() => undefined);
          setPrepared(null);
          notifyToast({
            title: t('No se reconoce el blockhash de Devnet'),
            message: t('La conexión RPC no está en Solana Devnet. Cambia a Devnet y vuelve a intentar.'),
          });
          return;
        }

        setPrepared(refreshed);
        notifyToast({
          title: t('La revisión del retiro venció'),
          message: t('Preparé una revisión nueva. Comprueba los importes y vuelve a pulsar «Revisar y firmar». No se envió ningún retiro.'),
        });
        return;
      }
      const clientPreparedHash = await hashTransactionMessage(tx);
      if (clientPreparedHash !== prepared.transactionMessageHash) {
        throw new Error('El mensaje recibido no coincide con la transacción preparada. Cancela esta revisión y vuelve a preparar el retiro.');
      }
      const preparedMessageSnapshot = Transaction.from(Buffer.from(prepared.transaction, 'base64'));
      const signedTx = await signWithdrawal(tx);
      const signedMessageHash = await hashTransactionMessage(signedTx);
      if (signedMessageHash !== clientPreparedHash) {
        const changes = changedTransactionParts(preparedMessageSnapshot, signedTx);
        await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
        }).catch(() => undefined);
        setPrepared(null);
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
        const detail = changes.length ? ` Parte modificada: ${changes.join(', ')}.` : '';
        throw new Error(`La wallet cambió el mensaje al firmar.${detail} No se envió la transacción. Prepara el retiro de nuevo.`);
      }
      setOperationStage('registering');
      const registerRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, signedTransaction: signedTx.serialize().toString('base64') }),
      });
      const registerData = await registerRes.json();
      if (!registerRes.ok || !registerData.success || typeof registerData.txHash !== 'string') throw new Error(registerData.error || 'Could not register the signed withdrawal');
      txId = registerData.txHash;

      setOperationStage('confirming');
      const sentTxId = await rpcConn.sendRawTransaction(signedTx.serialize());
      if (sentTxId !== txId) throw new Error('Wallet returned a different transaction signature');
      const confirmation = await rpcConn.confirmTransaction({
        signature: txId, blockhash: tx.recentBlockhash!, lastValidBlockHeight: prepared.lastValidBlockHeight,
      }, 'confirmed');
      const resultRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, txHash: txId }),
      });
      const resultData = await resultRes.json();
      if (!resultRes.ok || !resultData.success || resultData.status !== 'completed' || confirmation.value.err) throw new Error(resultData.error || 'Withdrawal was not confirmed successfully');

      setResult({
        txId,
        quoteSymbol: prepared.quoteSymbol,
        quoteDecimals: prepared.quoteDecimals,
        quoteAmountRaw: prepared.quoteAmountRaw,
        minimumQuoteOutRaw: prepared.minimumQuoteOutRaw,
        platformFeeRaw: prepared.platformFeeRaw,
        tokenOutAmount: prepared.tokenOutAmount,
        minimumTokenOutAmount: prepared.minimumTokenOutAmount,
        tokenSymbol: prepared.tokenSymbol,
        fullWalletPosition: percent === 100,
      });
      setPrepared(null);
      if (percent === 100) {
        markStoredTokenCreationPoolWithdrawn(withdrawalWalletAddress, poolAddress);
        setFullWithdrawalRecorded(true);
      }
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      setPercent(0);
      await fetchBalance();
    } catch (error: any) {
      if (!txId && /blockhash not found/i.test(String(error?.message ?? error))) {
        await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
        }).catch(() => undefined);
        setPrepared(null);
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
        try {
          setOperationStage('preparing');
          const refreshed = await requestPreparedWithdrawal();
          const refreshedTx = Transaction.from(Buffer.from(refreshed.transaction, 'base64'));
          const refreshedBlockhashStatus = refreshedTx.recentBlockhash
            ? await new Connection(process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com')
              .isBlockhashValid(refreshedTx.recentBlockhash, { commitment: 'confirmed' })
            : { value: false };
          if (refreshedBlockhashStatus.value) setPrepared(refreshed);
          else {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ withdrawalId: refreshed.withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
            }).catch(() => undefined);
          }
          notifyToast({
            title: refreshedBlockhashStatus.value ? t('La revisión del retiro venció') : t('No se reconoce el blockhash de Devnet'),
            message: refreshedBlockhashStatus.value
              ? t('Preparé una revisión nueva. Comprueba los importes y vuelve a pulsar «Revisar y firmar». No se envió ningún retiro.')
              : t('La conexión RPC no está en Solana Devnet. Cambia a Devnet y vuelve a intentar.'),
          });
        } catch {
          notifyToast({
            title: t('No se pudo renovar la revisión'),
            message: t('El blockhash no era válido y no se envió el retiro. Vuelve a preparar la operación antes de firmar.'),
          });
        }
        return;
      }
      if (error instanceof Error && /La transacción firmada cambió respecto a la preparada/i.test(error.message) && withdrawalWalletAddress) {
        await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, cancel: true }),
        }).catch(() => undefined);
        setPrepared(null);
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
      }
      if (txId && withdrawalWalletAddress) {
        try {
          await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdrawal-result`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ withdrawalId: prepared.withdrawalId, userWallet: withdrawalWalletAddress, txHash: txId }),
          });
        } catch { /* The server reconciles the signed transaction if this update fails. */ }
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
      }
      notifyToast({ title: t('No se pudo completar el retiro'), message: userFacingError(error, t('Inténtalo de nuevo.'), t) });
    } finally {
      setLoading(false);
      setOperationStage(null);
    }
  };
  return (
    <div className="wire-withdraw-page mx-auto w-full max-w-2xl">
      <button type="button" onClick={() => { void handleCancelPreparation(); onBack(); }} disabled={loading} className="wire-button wire-button-quiet mb-5 min-h-11 justify-start px-0 text-sm">
        {'<-'} {t('Volver')}
      </button>

      <div className="wire-kicker mb-2"><span className="wire-status-dot" aria-hidden="true" />{t('LIQUIDEZ · DEVNET')}</div>
      <h2 className="mb-3 font-display text-3xl font-semibold tracking-tight">{t('Retira liquidez')}</h2>
      <p className="mb-6 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
        {t('El pool devuelve {asset} y el otro token según tu participación. Wire cobra 10% de la estimación en {asset} mediante una transferencia en la misma transacción; el 1% de deslizamiento limita el mínimo que aceptas retirar.', { asset: poolQuoteSymbol })}
      </p>

      <div className="wire-withdraw-card space-y-5">
        <div className="wire-input rounded-lg p-2.5 text-[11px] font-mono text-[var(--muted)] break-all">
          Pool: {poolAddress}
        </div>
        <div className="wire-input rounded-lg p-2.5 text-[11px] text-[var(--muted)]">
          {t(vaultSigner ? 'La bóveda firmará localmente con' : 'Phantom firmará con')}: <strong>{vaultSigner?.label || t('Wallet conectada')}</strong>
          <code className="mt-1 block break-all font-mono">{withdrawalWalletAddress}</code>
        </div>

        {loadingBalance ? (
          <div className="text-sm text-[var(--muted)]">{t('Leyendo tu balance de LP...')}</div>
        ) : balanceError ? (
          <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-4 text-sm" role="alert">
            <h3 className="font-semibold text-[var(--text)]">{t('No se pudo leer el balance LP')}</h3>
            <p className="mt-1 text-[var(--muted)]">{balanceError}</p>
            {balanceErrorReference ? <p className="mt-1 text-xs text-[var(--muted)]">{t('Referencia del servidor')}: <code>{balanceErrorReference}</code></p> : null}
            <button type="button" onClick={() => { void fetchBalance(); }} className="wire-button wire-button-secondary mt-3 min-h-11">
              {t('Reintentar')}
            </button>
          </div>
        ) : (
          <>
            <div className="wire-withdraw-balance">
              <span className="text-sm text-[var(--muted)]">{t('Saldo LP disponible')}</span><strong>{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(uiBalance)}</strong>
            </div>

            {hasLpBalance ? <>
            <p className="wire-withdraw-note" role="status"><strong>{t('Posición LP activa')}</strong> — {t('La wallet tiene saldo LP confirmado. Este valor describe la posición de esta dirección, no la liquidez total de la pool.')}</p>
            <p className="wire-withdraw-note">
              {t('Puedes retirar hasta el 100% de los LP disponibles en esta wallet. Al retirar el 100%, vacías tu posición; la pool y sus cuentas siguen existiendo en Solana.')}
            </p>
            <div>
              <div className="flex justify-between items-baseline mb-2">
                <label htmlFor="withdraw-percent" className="text-sm text-[var(--muted)]">{t('Porcentaje de tu saldo actual')}</label>
                <span className="font-display text-2xl tabular-nums">{percent}%</span>
              </div>
              <input
                id="withdraw-percent"
                type="range"
                min={0}
                max={100}
                step={1}
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
                disabled={loading || Boolean(prepared)}
                className="w-full"
                style={{ accentColor: 'var(--wire-green)' }}
                aria-valuetext={t('{percent}% del saldo LP disponible para esta operación', { percent })}
              />
              <div className="flex justify-between text-[11px] text-[var(--muted)] mt-1">
                <span>0%</span>
                <span>{t('100% (máx.)')}</span>
              </div>
              <div className="flex gap-2 mt-3">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    onClick={() => setPercent(p)}
                    type="button"
                    aria-pressed={percent === p}
                    disabled={loading || Boolean(prepared)}
                    className={`wire-button ${percent === p ? 'wire-button-primary' : 'wire-button-secondary'} min-h-11 flex-1 px-2 py-1.5 text-xs`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>

            <div className="wire-input flex flex-wrap items-center justify-between gap-2 rounded-lg p-4 text-sm">
              <span className="text-[var(--muted)]">{t('LP estimados para retirar')}</span><strong className="font-mono tabular-nums">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(uiAmountToWithdraw)}</strong>
            </div>
            </> : (
              <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-4 text-sm text-[var(--muted)]" role="status">
                <h3 className="font-semibold text-[var(--text)]">{fullWithdrawalRecorded ? t('Retiro total registrado') : t('Sin saldo LP en esta wallet')}</h3>
                <p className="mt-1">{fullWithdrawalRecorded ? t('Wire registró un retiro confirmado del 100% desde esta wallet y la consulta actual confirma saldo LP cero aquí. La pool y sus cuentas siguen existiendo en Solana.') : t('La consulta confirmó cero LP para esta dirección. Esto no confirma que la pool esté vacía ni elimina sus cuentas.')}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Link href={`/token/${tokenMintAddress}`} className="wire-button wire-button-secondary min-h-11">
                    {t('Ver detalles del token')} <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                  <a href={`https://explorer.solana.com/address/${encodeURIComponent(poolAddress)}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11">
                    {t('Revisar pool en Explorer')} <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </div>
              </div>
            )}
          </>
        )}

        {!loadingBalance && hasLpBalance && !prepared && <button
          type="button"
          onClick={handlePrepareWithdrawal}
          disabled={loading || percent === 0}
          className="wire-button wire-button-primary w-full py-3 font-display"
        >
          {loading ? t('Preparando retiro…') : t('Preparar retiro')}
        </button>}
        {loading && operationStage && (
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3 text-sm text-[var(--muted)]" role="status" aria-live="polite">
            <span className="wire-loading-mark shrink-0" aria-hidden="true" />
            <span>{t(operationStage === 'preparing' ? 'Preparando la transacción…' : operationStage === 'signature' ? vaultSigner ? 'Firmando desde la bóveda…' : 'Esperando tu firma en la wallet…' : operationStage === 'registering' ? 'Registrando el envío seguro…' : 'Esperando confirmación en Solana…')}</span>
          </div>
        )}
      </div>

      {prepared && <section className="wire-panel mb-4 space-y-4 p-4 sm:p-5" aria-labelledby="withdraw-review-title">
        <div><h3 id="withdraw-review-title" className="font-display text-lg font-semibold">{t('Revisa el retiro')}</h3><p className="mt-1 text-sm text-[var(--muted)]">{t('Estimación de salida del pool. El monto final puede variar dentro del margen de deslizamiento indicado.')}</p></div>
        <dl className="space-y-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-4">
          <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--muted)]">{t('Activo de cotización estimado que sale del pool', { asset: prepared.quoteSymbol })}</dt><dd className="font-mono tabular-nums">{formatRawAssetAmount(prepared.quoteAmountRaw, prepared.quoteDecimals, locale)} {prepared.quoteSymbol}</dd></div>
          <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--muted)]">{t('Token estimado que sale del pool')} ({prepared.tokenSymbol})</dt><dd className="max-w-[58%] break-all text-right font-mono tabular-nums">{prepared.tokenOutAmount} {prepared.tokenSymbol}</dd></div>
          <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--muted)]">{t('Mínimo de token aceptado')} ({prepared.tokenSymbol})</dt><dd className="max-w-[58%] break-all text-right font-mono tabular-nums">{prepared.minimumTokenOutAmount} {prepared.tokenSymbol}</dd></div>
          <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--muted)]">{t('Mínimo de cotización aceptado', { asset: prepared.quoteSymbol })}</dt><dd className="font-mono tabular-nums">{formatRawAssetAmount(prepared.minimumQuoteOutRaw, prepared.quoteDecimals, locale)} {prepared.quoteSymbol}</dd></div>
          <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--muted)]">{t('Neto estimado tras el fee (sin fee de red)')}</dt><dd className="font-mono tabular-nums">{formatRawAssetAmount((BigInt(prepared.quoteAmountRaw) - BigInt(prepared.platformFeeRaw)).toString(), prepared.quoteDecimals, locale)} {prepared.quoteSymbol}</dd></div>
          <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--muted)]">{t('Fee de Wire (10%, transferencia dentro de la transacción)')}</dt><dd className="font-mono tabular-nums">{formatRawAssetAmount(prepared.platformFeeRaw, prepared.quoteDecimals, locale)} {prepared.quoteSymbol}</dd></div>
        </dl>
        <p className="text-xs leading-relaxed text-[var(--muted)]">{t(vaultSigner ? 'La transacción está preparada y aún no se ha enviado. Después de tu clic, la wallet elegida en la bóveda la firmará localmente; Wire no recibe la clave privada. Si cancelas, Wire marcará la preparación como cancelada y no la enviará. El fee de red se cobra aparte.' : 'La transacción está preparada y aún no se ha enviado. Phantom te mostrará los detalles; si cancelas, Wire marcará la preparación como cancelada y no la enviará. El fee de red se cobra aparte.')}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <button type="button" onClick={handleCancelPreparation} disabled={loading} className="wire-button wire-button-secondary w-full">{t('Cancelar revisión')}</button>
          <button type="button" onClick={handleConfirmWithdrawal} disabled={loading} className="wire-button wire-button-primary w-full">{loading ? t(vaultSigner ? 'Firmando desde la bóveda…' : 'Esperando a Phantom…') : t(vaultSigner ? 'Revisar y firmar localmente' : 'Revisar y firmar en Phantom')}</button>
        </div>
      </section>}

      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setResult(null); }}>
          <section ref={resultDialogRef} className="wire-panel wire-dialog-enter w-full max-w-md rounded-2xl p-5 sm:p-7" role="dialog" aria-modal="true" aria-labelledby="withdraw-success-title" aria-describedby="withdraw-success-description" tabIndex={-1}>
            <div className="mb-3 flex justify-end">
              <button type="button" onClick={() => setResult(null)} className="wire-button wire-button-quiet h-10 w-10 p-0" aria-label={t('Cerrar resultado del retiro')}><X size={17} aria-hidden="true" /></button>
            </div>
            <div className="wire-success-mark mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-[var(--success)]/35 bg-[var(--success)]/10 text-[var(--success)]" aria-hidden="true"><Check size={21} /></div>
            <h3 id="withdraw-success-title" className="font-display text-lg font-semibold">{t('Retiro completado')}</h3>
            <p id="withdraw-success-description" className="mt-2 text-sm text-[var(--muted)]">{result.fullWalletPosition ? t('Retiraste el 100% de los LP disponibles en esta wallet. La pool y sus cuentas siguen existiendo en Solana.') : t('La operación quedó confirmada en Devnet. Las cantidades mostradas son estimaciones al preparar la transacción.')}</p>
            <div className="mt-5 space-y-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-4">
              <div className="flex justify-between gap-4 text-sm"><span className="text-[var(--muted)]">{t('Activo de cotización estimado que salió del pool', { asset: result.quoteSymbol })}</span><strong className="font-mono text-[var(--success)]">{formatRawAssetAmount(result.quoteAmountRaw, result.quoteDecimals, locale)} {result.quoteSymbol}</strong></div>
              <div className="flex justify-between gap-4 text-sm"><span className="text-[var(--muted)]">{t('Token estimado que salió del pool')} ({result.tokenSymbol})</span><strong className="max-w-[58%] break-all text-right font-mono">{result.tokenOutAmount} {result.tokenSymbol}</strong></div>
              <div className="flex justify-between gap-4 text-sm"><span className="text-[var(--muted)]">{t('Mínimo de token aceptado')} ({result.tokenSymbol})</span><strong className="max-w-[58%] break-all text-right font-mono">{result.minimumTokenOutAmount} {result.tokenSymbol}</strong></div>
              <div className="flex justify-between gap-4 text-sm"><span className="text-[var(--muted)]">{t('Mínimo de cotización aceptado', { asset: result.quoteSymbol })}</span><strong className="font-mono">{formatRawAssetAmount(result.minimumQuoteOutRaw, result.quoteDecimals, locale)} {result.quoteSymbol}</strong></div>
              <div className="flex justify-between gap-4 text-sm"><span className="text-[var(--muted)]">{t('Neto estimado tras el fee (sin fee de red)')}</span><strong className="font-mono">{formatRawAssetAmount((BigInt(result.quoteAmountRaw) - BigInt(result.platformFeeRaw)).toString(), result.quoteDecimals, locale)} {result.quoteSymbol}</strong></div>
              <div className="flex justify-between gap-4 text-sm"><span className="text-[var(--muted)]">{t('Fee de Wire (transferido en la misma transacción)')}</span><strong className="font-mono">{formatRawAssetAmount(result.platformFeeRaw, result.quoteDecimals, locale)} {result.quoteSymbol}</strong></div>
            </div>
            <a href={`https://explorer.solana.com/tx/${result.txId}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary mt-4 w-full">
              {t('Ver transacción en Explorer')} <ExternalLink size={15} aria-hidden="true" />
            </a>
            <button type="button" onClick={() => setResult(null)} className="wire-button wire-button-quiet mt-2 w-full">{t('Listo')}</button>
          </section>
        </div>
      )}
    </div>
  );
}
