'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { clusterApiUrl, ComputeBudgetProgram, Connection, Transaction } from '@solana/web3.js';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useWalletIdentity } from './WalletIdentityProvider';
import { notifyToast, userFacingError } from './toastEvents';
import { useWireLocale } from './LocaleProvider';
import { checkPreparedBlockhash } from '../lib/blockhashPreflight';

interface PoolCreateProps {
  mintAddress: string;
  tokenSymbol: string;
  defaultTokenAmount: string;
  defaultSolAmount: string;
  onBack: () => void;
  onPoolCreated?: (pool: { txId: string; poolId: string }) => void;
}

type PendingPoolSubmission = {
  signedTransaction: string;
  userWallet: string;
  mintAddress: string;
  poolAddress: string;
  lastValidBlockHeight: number;
};

type PoolSubmissionError = Error & { retryable?: boolean; status?: number; errorId?: string };

const devnetRpcUrl = clusterApiUrl('devnet');

async function checkPoolBlockhash(blockhash: string, lastValidBlockHeight: number) {
  const endpoint = process.env.NEXT_PUBLIC_RPC_ENDPOINT || devnetRpcUrl;
  const primary = new Connection(endpoint, 'confirmed');
  let primaryState: Awaited<ReturnType<typeof checkPreparedBlockhash>> = 'unrecognized';
  try {
    primaryState = await checkPreparedBlockhash(primary, blockhash, lastValidBlockHeight);
  } catch {
    // Retry the read using Solana's public Devnet RPC below.
  }

  if (primaryState !== 'unrecognized' || primary.rpcEndpoint === devnetRpcUrl) return primaryState;
  const fallback = new Connection(devnetRpcUrl, 'confirmed');
  return checkPreparedBlockhash(fallback, blockhash, lastValidBlockHeight);
}

async function getPoolBlockHeight() {
  const endpoint = process.env.NEXT_PUBLIC_RPC_ENDPOINT || devnetRpcUrl;
  const primary = new Connection(endpoint, 'confirmed');
  try {
    return await primary.getBlockHeight('confirmed');
  } catch (primaryError) {
    if (primary.rpcEndpoint === devnetRpcUrl) throw primaryError;
    const fallback = new Connection(devnetRpcUrl, 'confirmed');
    return fallback.getBlockHeight('confirmed');
  }
}

function getPoolToastMessage(error: unknown, fallback: string, translate: (key: string) => string) {
  const message = userFacingError(error, fallback, translate);
  const errorId = (error as PoolSubmissionError | null)?.errorId;
  return errorId ? `${message} · ${translate('Referencia del servidor')}: ${errorId}` : message;
}

export default function PoolCreate({
  mintAddress,
  tokenSymbol,
  defaultTokenAmount,
  defaultSolAmount,
  onBack,
  onPoolCreated,
}: PoolCreateProps) {
  const { publicKey, signTransaction } = useWallet();
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const poolActionInFlightRef = useRef(false);
  const { identifiedWallet } = useWalletIdentity();
  const walletAddress = publicKey?.toBase58() ?? null;
  const isIdentified = Boolean(walletAddress && identifiedWallet === walletAddress);

  const [tokenAmount, setTokenAmount] = useState(defaultTokenAmount);
  const [quoteAsset, setQuoteAsset] = useState<'SOL' | 'USDC'>('SOL');
  const [quoteAmount, setQuoteAmount] = useState(defaultSolAmount);
  const [loading, setLoading] = useState(false);
  const [operationStage, setOperationStage] = useState<'preparing' | 'signature' | 'registering' | null>(null);
  const [pendingPoolSubmission, setPendingPoolSubmission] = useState<PendingPoolSubmission | null>(null);
  const [poolResult, setPoolResult] = useState<{ txId: string; poolId: string } | null>(null);
  const [existingPool, setExistingPool] = useState<string | null>(null);
  const [checkingPool, setCheckingPool] = useState(true);
  const [poolCheckFailed, setPoolCheckFailed] = useState(false);
  const [poolCheckAttempt, setPoolCheckAttempt] = useState(0);
  const tokenAmountValid = /^[1-9]\d{0,19}$/.test(tokenAmount);
  const availableTokenAmountValid = /^[1-9]\d{0,19}$/.test(defaultTokenAmount);
  const poolTokenAmount = tokenAmountValid ? BigInt(tokenAmount) : BigInt(0);
  const availableTokenAmount = availableTokenAmountValid ? BigInt(defaultTokenAmount) : BigInt(0);
  const quoteDecimals = quoteAsset === 'SOL' ? 9 : 6;
  const quoteAmountValid = new RegExp(`^\\d{1,20}(?:\\.\\d{1,${quoteDecimals}})?$`).test(quoteAmount)
    && Number.isFinite(Number(quoteAmount)) && Number(quoteAmount) > 0;
  const formatQuote = (amount: string) => {
    const [whole = '0', fraction = ''] = amount.split('.');
    const numberLocale = locale === 'es' ? 'es-419' : 'en-US';
    const wholeText = new Intl.NumberFormat(numberLocale).format(BigInt(whole));
    const decimal = new Intl.NumberFormat(numberLocale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
    return `${wholeText}${fraction ? `${decimal}${fraction}` : ''} ${quoteAsset}`;
  };
  const formatTokenAmount = (amount: bigint) => new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(amount);
  const canCreatePool = tokenAmountValid
    && availableTokenAmountValid
    && poolTokenAmount <= availableTokenAmount
    && quoteAmountValid;
  const poolBlockReason = !tokenAmountValid
    ? t('Indica una cantidad entera de tokens mayor que cero.')
    : !availableTokenAmountValid || poolTokenAmount > availableTokenAmount
      ? t('La cantidad supera los tokens disponibles para este lanzamiento.')
      : !quoteAmountValid
        ? t('El aporte de {asset} debe ser mayor que cero y respetar sus decimales.', { asset: quoteAsset })
        : '';

  useEffect(() => { translateRef.current = t; }, [t]);


  useEffect(() => {
    let active = true;

    const checkExistingPool = async () => {
      if (!walletAddress || !isIdentified) {
        setExistingPool(null);
        setPoolCheckFailed(false);
        setCheckingPool(false);
        return;
      }

      setCheckingPool(true);
      setPoolCheckFailed(false);
      try {
        const response = await fetch((process.env.NEXT_PUBLIC_API_URL || '') + '/api/my-pools', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'No se pudo comprobar si el token ya tiene una pool');
        }

        const pool = data.pools.find((item: { mintAddress: string; poolAddress: string }) =>
          item.mintAddress === mintAddress
        );
        if (active && pool) setExistingPool(pool.poolAddress);
      } catch {
        if (active) {
          setPoolCheckFailed(true);
          notifyToast({ title: translateRef.current('No se pudo comprobar la pool'), message: translateRef.current('Reintenta la comprobación antes de crear otra.') });
        }
      } finally {
        if (active) setCheckingPool(false);
      }
    };

    checkExistingPool();
    return () => {
      active = false;
    };
  }, [mintAddress, walletAddress, isIdentified, poolCheckAttempt]);
  const handleCreatePool = async () => {
    if (!canCreatePool || pendingPoolSubmission || loading || poolActionInFlightRef.current) return;
    if (!isIdentified) {
      notifyToast({ title: t('Identifica tu wallet'), message: t('Abre el panel Wallet e inicia sesión para crear la pool.') });
      return;
    }
    if (!publicKey || !signTransaction) {
      notifyToast({ title: t('Conecta tu wallet'), message: t('Conecta una wallet de Solana para crear la pool.') });
      return;
    }
    poolActionInFlightRef.current = true;
    setLoading(true);
    setOperationStage('preparing');
    let signedSubmission: PendingPoolSubmission | null = null;

    try {
      const tokenAmountRaw = (BigInt(tokenAmount) * BigInt(1e9)).toString();

      const createRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/create-pool`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userWallet: publicKey.toBase58(),
          mintAddress,
          tokenAmount: tokenAmountRaw,
          quoteAsset,
          quoteAmount,
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) {
        const createError = new Error(createData.error || 'Failed to prepare pool creation') as PoolSubmissionError;
        createError.status = createRes.status;
        createError.errorId = typeof createData.errorId === 'string' ? createData.errorId : undefined;
        throw createError;
      }
      if (!Number.isSafeInteger(createData.lastValidBlockHeight) || createData.lastValidBlockHeight <= 0) {
        throw new Error(t('El servidor no devolvió la vigencia de la transacción. Prepara de nuevo la pool.'));
      }

      // Keep the blockhash and fee payer prepared by Wire. The backend binds
      // this exact message to the pending pool attempt before returning it.
      const tx = Transaction.from(Buffer.from(createData.transaction, 'base64'));
      if (!tx.feePayer?.equals(publicKey) || !tx.recentBlockhash) {
        throw new Error(t('La transacción preparada no coincide con esta wallet. Vuelve a intentarlo.'));
      }

      let blockhashState: Awaited<ReturnType<typeof checkPreparedBlockhash>>;
      try {
        blockhashState = await checkPoolBlockhash(tx.recentBlockhash, createData.lastValidBlockHeight);
      } catch {
        throw new Error(t('No se pudo comprobar la vigencia en Solana. No se solicitó la firma; revisa la conexión a Devnet e inténtalo de nuevo.'));
      }
      if (blockhashState !== 'valid') {
        throw new Error(t(blockhashState === 'expired'
          ? 'El blockhash venció antes de abrir tu wallet. No se solicitó la firma. Prepara de nuevo la pool.'
          : 'El RPC del navegador no reconoce el blockhash. No se solicitó la firma; comprueba que Wire y Phantom estén en Devnet.'));
      }

      // Some wallets add their own Compute Budget instructions while signing.
      // Remove the builder's copies first so the signed transaction cannot
      // contain duplicate budget variants (which Solana rejects on-chain).
      tx.instructions = tx.instructions.filter(
        (instruction) => !instruction.programId.equals(ComputeBudgetProgram.programId),
      );

      setOperationStage('signature');
      const signedTx = await signTransaction(tx);

      setOperationStage('preparing');
      if (!signedTx.feePayer?.equals(publicKey) || signedTx.recentBlockhash !== tx.recentBlockhash) {
        throw new Error(t('La wallet modificó la transacción preparada. No se envió.'));
      }
      let signedBlockhashState: Awaited<ReturnType<typeof checkPreparedBlockhash>>;
      try {
        signedBlockhashState = await checkPoolBlockhash(signedTx.recentBlockhash, createData.lastValidBlockHeight);
      } catch {
        throw new Error(t('No se pudo volver a comprobar la vigencia después de firmar. No se envió la pool; vuelve a prepararla.'));
      }
      if (signedBlockhashState !== 'valid') {
        throw new Error(t(signedBlockhashState === 'expired'
          ? 'El blockhash venció mientras revisabas en Phantom. No se envió la pool; prepara la operación otra vez.'
          : 'La RPC no confirmó la transacción firmada. No se envió la pool; comprueba que Wire y Phantom estén en Devnet.'));
      }

      signedSubmission = {
        signedTransaction: signedTx.serialize().toString('base64'),
        userWallet: publicKey.toBase58(),
        mintAddress,
        poolAddress: createData.poolId,
        lastValidBlockHeight: createData.lastValidBlockHeight,
      };
      setPendingPoolSubmission(signedSubmission);
      setOperationStage('registering');
      await submitPreparedPool(signedSubmission);
    } catch (err: any) {
      const retryable = Boolean(err?.retryable && signedSubmission);
      if (!retryable) setPendingPoolSubmission(null);
      if (err?.status === 409) setPoolCheckAttempt((attempt) => attempt + 1);
      notifyToast({
        title: t(signedSubmission ? 'No se pudo registrar la pool' : 'No se pudo crear la pool'),
        message: getPoolToastMessage(err, t('Inténtalo de nuevo.'), t),
        action: retryable ? { label: t('Reintentar registro'), onClick: () => { void handleRetryPoolRegistration(signedSubmission!); } } : undefined,
      });
    } finally {
      poolActionInFlightRef.current = false;
      setLoading(false);
      setOperationStage((current) => current === 'registering' ? null : current);
    }
  };

  const submitPreparedPool = async (payload: PendingPoolSubmission) => {
    let response: Response;
    try {
      response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/submit-pool-transaction`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const retryError = new Error(error instanceof Error ? error.message : t('wallet.error.network')) as PoolSubmissionError;
      retryError.retryable = true;
      throw retryError;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      const parseError = new Error(t('No se pudo leer la respuesta del servidor.')) as PoolSubmissionError;
      parseError.retryable = response.ok || response.status >= 500 || response.status === 429;
      parseError.status = response.status;
      throw parseError;
    }
    if (!response.ok || !data.success) {
      const submitError = new Error(data.error || 'Pool transaction submission failed') as PoolSubmissionError;
      submitError.retryable = response.status >= 500 || response.status === 429;
      submitError.status = response.status;
      submitError.errorId = typeof data.errorId === 'string' ? data.errorId : undefined;
      throw submitError;
    }

    const result = { txId: data.txId, poolId: data.poolId };
    setPoolResult(result);
    setPendingPoolSubmission(null);
    onPoolCreated?.(result);
  };

  const handleRetryPoolRegistration = async (payload: PendingPoolSubmission) => {
    if (loading || poolActionInFlightRef.current) return;
    poolActionInFlightRef.current = true;
    setLoading(true);
    setOperationStage('registering');
    try {
      let currentBlockHeight: number;
      try {
        currentBlockHeight = await getPoolBlockHeight();
      } catch (error) {
        const retryError = new Error(error instanceof Error ? error.message : t('No se pudo comprobar la vigencia de la transacción.')) as PoolSubmissionError;
        retryError.retryable = true;
        throw retryError;
      }
      if (currentBlockHeight > payload.lastValidBlockHeight) {
        const expiredError = new Error(t('La transacción firmada expiró. Prepara la pool otra vez y solicita una firma nueva.')) as PoolSubmissionError;
        expiredError.retryable = false;
        throw expiredError;
      }
      await submitPreparedPool(payload);
    } catch (error: any) {
      const retryable = Boolean(error?.retryable);
      if (!retryable) setPendingPoolSubmission(null);
      if (error?.status === 409) setPoolCheckAttempt((attempt) => attempt + 1);
      notifyToast({
        title: t('No se pudo registrar la pool'),
        message: getPoolToastMessage(error, t('Inténtalo de nuevo.'), t),
        action: retryable ? { label: t('Reintentar registro'), onClick: () => { void handleRetryPoolRegistration(payload); } } : undefined,
      });
    } finally {
      poolActionInFlightRef.current = false;
      setLoading(false);
      setOperationStage(null);
    }
  };

  if (poolResult) {
    return (
      <section className="wire-panel wire-enter mx-auto max-w-xl rounded-2xl p-6 sm:p-8" aria-labelledby="pool-created-title" aria-live="polite">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]" aria-hidden="true">
          <ExternalLink size={21} />
        </div>
        <p className="wire-kicker mb-2">Raydium · Devnet</p>
        <h2 id="pool-created-title" className="mb-2 font-display text-2xl font-semibold">{t('Pool creada')}</h2>
        <p className="mb-5 text-sm leading-relaxed text-[var(--muted)]">
          {t('Ya puedes encontrar esta pool en Administrar liquidez. El token y la pool siguen en Devnet.')}
        </p>
        <div className="mb-5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
          <span className="mb-1 block text-xs text-[var(--muted)]">{t('Dirección de la pool')}</span>
          <span className="block break-all font-mono text-xs text-[var(--text)]">{poolResult.poolId}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Link href="/manage-liquidity" className="wire-button wire-button-primary w-full">{t('Administrar liquidez')}</Link>
          <Link href={`/token/${mintAddress}`} className="wire-button wire-button-secondary w-full">{t('Ver detalles del token')}</Link>
          <a href={`https://explorer.solana.com/address/${poolResult.poolId}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full">
            {t('Ver pool en Explorer')} <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a href={`https://explorer.solana.com/tx/${poolResult.txId}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full">
            {t('Ver transacción')} <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </section>
    );
  }

  if (!publicKey || !isIdentified) {
    return (
      <div className="max-w-xl mx-auto">
        <button type="button" onClick={onBack} className="wire-button wire-button-quiet mb-5 min-h-11 justify-start px-0 text-sm">
          {'<-'} {t('Volver')}
        </button>
        <div className="glass-card rounded-2xl p-6 text-sm text-[var(--muted)]">
          {!publicKey ? t('Conecta tu wallet para crear una pool.') : t('Identifica tu wallet desde el panel Wallet para comprobar y crear la pool.')}
        </div>
      </div>
    );
  }

  if (checkingPool) {
    return (
      <div className="max-w-xl mx-auto">
        <button type="button" onClick={onBack} className="wire-button wire-button-quiet mb-5 min-h-11 justify-start px-0 text-sm">
          {'<-'} {t('Volver')}
        </button>
        <div className="glass-card rounded-2xl p-6 text-sm text-[var(--muted)]">
          {t('Comprobando si el token ya tiene una pool...')}
        </div>
      </div>
    );
  }

  if (poolCheckFailed) {
    return (
      <div className="max-w-xl mx-auto">
        <button type="button" onClick={onBack} className="wire-button wire-button-quiet mb-5 min-h-11 justify-start px-0 text-sm">
          {'<-'} {t('Volver')}
        </button>
        <div className="glass-card rounded-2xl p-6 space-y-3">
          <div className="text-sm text-red-300" role="status">
            {t('No se pudo comprobar si ya existe una pool. Reintenta antes de crear otra.')}
          </div>
          <button
            type="button"
            onClick={() => setPoolCheckAttempt((attempt) => attempt + 1)}
            className="wire-button wire-button-secondary w-full"
          >
            {t('Reintentar comprobación')}
          </button>
        </div>
      </div>
    );
  }

  if (existingPool) {
    return (
      <div className="max-w-xl mx-auto">
        <button type="button" onClick={onBack} className="wire-button wire-button-quiet mb-5 min-h-11 justify-start px-0 text-sm">
          {'<-'} {t('Volver')}
        </button>
        <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>
          {t('ETAPA 2 · LIQUIDEZ')}
        </div>
        <h2 className="font-display text-2xl mb-2">{t('Pool existente')}</h2>
        <p className="text-sm text-[var(--muted)] mb-6">
          {t('existingPool.message', { token: tokenSymbol || t('Este token') })}
        </p>
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <div className="wire-input rounded-lg p-2.5 text-[11px] font-mono text-[var(--muted)] break-all">
            Pool: {existingPool}
          </div>
          <Link href="/manage-liquidity" className="wire-button wire-button-primary w-full">
            {t('Administrar liquidez')}
          </Link>
          <Link href={`/token/${mintAddress}`} className="wire-button wire-button-secondary w-full">{t('Ver detalles del token')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="wire-pool-create mx-auto w-full max-w-5xl">
      <button type="button" onClick={onBack} className="wire-button wire-button-quiet mb-5 min-h-11 justify-start px-0 text-sm">
        {'<-'} {t('Volver')}
      </button>

      <div className="wire-pool-create-layout">
      <section className="wire-pool-create-main">
      <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>{t('ETAPA 2 · LIQUIDEZ')}</div>
      <h2 className="font-display text-2xl mb-2">{t('Crea el pool en Raydium')}</h2>
      <p className="text-sm text-[var(--muted)] mb-6">
        {t('Define cuánto supply y cuánto {asset} entran al pool. Esto permite intercambiar {token} en Raydium.', { asset: quoteAsset, token: tokenSymbol || t('tu token') })}
      </p>

      <div className="wire-pool-create-card space-y-4">
        <div>
          <span className="text-sm text-[var(--muted)] block mb-2">{t('Moneda de cotización')}</span>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('Moneda de cotización')}>
            {(['SOL', 'USDC'] as const).map((asset) => (
              <button
                key={asset}
                type="button"
                aria-pressed={quoteAsset === asset}
                disabled={loading || Boolean(pendingPoolSubmission)}
                onClick={() => {
                  if (asset === quoteAsset) return;
                  setQuoteAsset(asset);
                  setQuoteAmount(asset === 'SOL' ? defaultSolAmount : '');
                }}
                className={`wire-button min-h-11 justify-center ${quoteAsset === asset ? 'wire-button-primary' : 'wire-button-secondary'}`}
              >{asset}{asset === 'USDC' ? ` · ${t('Devnet')}` : ''}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="wire-input flex-1 rounded-lg px-3 py-2.5 text-sm font-mono">{tokenSymbol || 'TOKEN'}</div>
          <span className="text-[var(--muted)]">+</span>
          <div className="wire-input flex-1 rounded-lg px-3 py-2.5 text-sm font-mono">{quoteAsset}</div>
        </div>

        <div>
          <label htmlFor="pool-token-amount" className="text-sm text-[var(--muted)] block mb-1">{t('Cantidad de {token}', { token: tokenSymbol || t('token') })}</label>
          <input
            id="pool-token-amount"
            type="number"
            min="1"
            max={defaultTokenAmount}
            step="1"
            required
            value={tokenAmount}
            onChange={(e) => setTokenAmount(e.target.value)}
            className="wire-input w-full rounded-lg p-2.5 text-sm font-mono"
          />
        </div>
        <div>
          <label htmlFor="pool-quote-amount" className="text-sm text-[var(--muted)] block mb-1">
            {t('Cantidad de {asset} para liquidez', { asset: quoteAsset })}
          </label>
          <input
            id="pool-quote-amount"
            type="text"
            inputMode="decimal"
            maxLength={40}
            required
            value={quoteAmount}
            onChange={(e) => setQuoteAmount(e.target.value)}
            className="wire-input w-full rounded-lg p-2.5 text-sm font-mono"
          />
          <p className="mt-2 text-xs text-[var(--muted)]">
            {t('Usa hasta {decimals} decimales. Necesitas SOL para la comisión de red.', { decimals: String(quoteDecimals) })}
            {quoteAsset === 'USDC' ? ` ${t('El par usa USDC de Devnet.')}` : ''}
          </p>
        </div>

        <section className="wire-input rounded-xl p-4" aria-label={t('Resumen antes de firmar')}>
          <h3 className="mb-3 text-sm font-semibold text-[var(--text)]">{t('Resumen antes de firmar')}</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--muted)]">{t('Tokens que aportarás')}</dt>
              <dd className="font-mono text-right">{formatTokenAmount(poolTokenAmount)} {tokenSymbol || t('Token')}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--muted)]">{t('{asset} que aportarás', { asset: quoteAsset })}</dt>
              <dd className="font-mono text-right">{quoteAmountValid ? formatQuote(quoteAmount) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-[var(--line)] pt-2">
              <dt className="text-[var(--muted)]">{t('Tarifa de Wire por crear la pool')}</dt>
              <dd className="font-mono text-right">0 SOL</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
            {t('El activo indicado se aporta a la liquidez y crear la pool no añade una tarifa de Wire. Conserva SOL para las cuentas y la comisión de red; revisa la transacción en Phantom antes de firmar.')}
          </p>
        </section>

        <button
          onClick={handleCreatePool}
          disabled={loading || !canCreatePool || Boolean(pendingPoolSubmission)}
          className="wire-button wire-button-primary w-full py-3 font-display"
        >
          {loading ? t('Creando pool…') : t('Crear pool')}
        </button>
        {pendingPoolSubmission && !loading && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-300/5 p-3 text-sm" role="alert">
            <p className="text-[var(--text)]">{t('La firma quedó lista, pero falta registrar la pool. Reintenta con la misma transacción; no hace falta firmar otra vez.')}</p>
            <button type="button" onClick={() => { void handleRetryPoolRegistration(pendingPoolSubmission); }} className="wire-button wire-button-secondary mt-3 w-full">
              {t('Reintentar registro')}
            </button>
          </div>
        )}
        {!canCreatePool && !loading && <p className="text-xs text-[var(--muted)]" role="status">{poolBlockReason}</p>}
        {loading && operationStage && (
          <div className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3 text-sm text-[var(--muted)]" role="status" aria-live="polite">
            <span className="wire-loading-mark shrink-0" aria-hidden="true" />
            <span>{t(operationStage === 'preparing' ? 'Preparando la transacción…' : operationStage === 'signature' ? 'Esperando tu firma en la wallet…' : 'Enviando y confirmando en Solana…')}</span>
          </div>
        )}
      </div>
      </section>
      <aside className="wire-pool-create-aside" aria-label={t('Información de la pool')}>
        <span className="wire-devnet-badge">SOLANA DEVNET</span>
        <h3>{t('Tu token')}<br /><strong>{tokenSymbol || 'TOKEN'}</strong><br />{t('y {asset}', { asset: quoteAsset })}</h3>
        <p>{t('El activo de cotización y los tokens que indiques se aportarán al crear la pool. Revisa los importes y la comisión de red en Phantom antes de confirmar.')}</p>
        <div className="wire-pool-create-aside-rule" />
        <div className="wire-pool-preview-row"><span>{t('Token')}</span><strong>{tokenSymbol || 'TOKEN'}</strong></div>
        <div className="wire-pool-preview-row"><span>{t('Liquidez {asset}', { asset: quoteAsset })}</span><strong>{quoteAmount || '0'} {quoteAsset}</strong></div>
        <p className="wire-pool-create-caption">{t('Crear la pool habilita el intercambio en Raydium Devnet.')}</p>
      </aside>
      </div>
    </div>
  );
}
