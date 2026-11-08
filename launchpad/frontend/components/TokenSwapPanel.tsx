'use client';

import { useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { ExternalLink, RefreshCw, ArrowDownUp, CircleHelp, ChevronDown } from 'lucide-react';
import { useWalletIdentity } from './WalletIdentityProvider';
import { useWireLocale } from './LocaleProvider';
import { notifyToast, userFacingError } from './toastEvents';
import ProjectWalletSwapPanel from './ProjectWalletSwapPanel';

type SwapSide = 'buy' | 'sell';
type SwapVenue = 'RAYDIUM' | 'PUMP_FUN' | 'PUMP_SWAP';
type SwapQuote = {
  venue: SwapVenue;
  poolAddress: string;
  side: SwapSide;
  inputMint: string;
  outputMint: string;
  inputSymbol: string;
  outputSymbol: string;
  quoteMint: string;
  quoteDecimals: number;
  amountIn: string;
  amountOut: string;
  minimumAmountOut: string;
  maximumAmountIn: string | null;
  estimatedPoolFee: string;
  priceImpactPercent: string | null;
  slippageBps: number;
  network: string;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
const SOLANA_EXPLORER_TX = (signature: string) =>
  `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
const explorerAddress = (address: string) =>
  `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;

async function hashMessage(message: Uint8Array): Promise<string> {
  const bytes = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validAmount(value: string, decimals: number): boolean {
  return new RegExp(`^(?:\\d{1,20})(?:\\.\\d{1,${decimals}})?$`).test(value) && /[1-9]/.test(value);
}

function parseAmountRaw(value: string, decimals: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) throw new Error('El importe de la cotización no es válido.');
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

async function ensureTokenInputBalance(
  connection: Connection,
  owner: PublicKey,
  mintAddress: string,
  amount: string,
  decimals: number,
) {
  const response = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mintAddress) }, 'confirmed');
  let balance = 0n;
  let found = false;
  for (const entry of response.value) {
    const info = entry.account.data.parsed.info as { tokenAmount?: { amount?: unknown; decimals?: unknown } };
    const tokenAmount = info?.tokenAmount;
    if (!tokenAmount || typeof tokenAmount.amount !== 'string' || !Number.isInteger(tokenAmount.decimals)) continue;
    if (tokenAmount.decimals !== decimals) throw new Error('La precisión del activo no coincide con la cotización.');
    found = true;
    balance += BigInt(tokenAmount.amount);
  }
  if (!found || balance < parseAmountRaw(amount, decimals)) {
    throw new Error('El saldo del token de entrada no alcanza para el importe máximo de la cotización.');
  }
}

function matchesReviewedQuote(reviewed: SwapQuote, prepared: SwapQuote): boolean {
  return reviewed.venue === prepared.venue
    && reviewed.poolAddress === prepared.poolAddress
    && reviewed.side === prepared.side
    && reviewed.inputMint === prepared.inputMint
    && reviewed.outputMint === prepared.outputMint
    && reviewed.inputSymbol === prepared.inputSymbol
    && reviewed.outputSymbol === prepared.outputSymbol
    && reviewed.quoteMint === prepared.quoteMint
    && reviewed.quoteDecimals === prepared.quoteDecimals
    && reviewed.amountIn === prepared.amountIn
    && reviewed.amountOut === prepared.amountOut
    && reviewed.minimumAmountOut === prepared.minimumAmountOut
    && reviewed.maximumAmountIn === prepared.maximumAmountIn
    && reviewed.estimatedPoolFee === prepared.estimatedPoolFee
    && reviewed.priceImpactPercent === prepared.priceImpactPercent
    && reviewed.slippageBps === prepared.slippageBps
    && reviewed.network === prepared.network;
}

export default function TokenSwapPanel({
  mintAddress,
  tokenSymbol,
  quoteMint,
  launchPlatform,
  reviewSellRequest,
}: {
  mintAddress: string;
  tokenSymbol: string;
  quoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  reviewSellRequest?: { amount: string; nonce: number } | null;
}) {
  const { t } = useWireLocale();
  const translateRef = useRef(t);
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { identifiedWallet, identifyWallet } = useWalletIdentity();
  const walletAddress = publicKey?.toBase58() ?? null;
  const solMint = 'So11111111111111111111111111111111111111112';
  const quoteSymbol = quoteMint === solMint ? 'SOL' : 'USDC';
  const quoteDecimals = quoteMint === solMint ? 9 : 6;
  const tokenDecimals = launchPlatform === 'PUMP_FUN' ? 6 : 9;
  const isIdentified = Boolean(walletAddress && identifiedWallet === walletAddress);
  const [side, setSide] = useState<SwapSide>('buy');
  const [amountIn, setAmountIn] = useState('');
  const [slippageBps, setSlippageBps] = useState(100);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [swapLoading, setSwapLoading] = useState(false);
  const [operationStage, setOperationStage] = useState<'preparing' | 'signature' | 'sending' | 'confirming' | null>(null);
  const [signature, setSignature] = useState('');
  const [signatureWallet, setSignatureWallet] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [swapFailed, setSwapFailed] = useState(false);
  const feeLabel = quote?.venue === 'PUMP_SWAP'
    ? 'Fees estimados de PumpSwap'
    : quote?.venue === 'PUMP_FUN' ? 'Fees estimados de Pump.fun' : 'Fee estimado del pool';
  const [historyRecordPending, setHistoryRecordPending] = useState(false);
  const [historyRetrying, setHistoryRetrying] = useState(false);
  const [signatureChecking, setSignatureChecking] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => { translateRef.current = t; }, [t]);

  useEffect(() => {
    if (!reviewSellRequest || !validAmount(reviewSellRequest.amount, tokenDecimals)) return;
    setSide('sell');
    setAmountIn(reviewSellRequest.amount);
    setQuote(null);
    setQuoteError('');
    window.requestAnimationFrame(() => {
      document.getElementById('token-swap-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById('swap-amount')?.focus({ preventScroll: true });
    });
  }, [reviewSellRequest?.nonce, reviewSellRequest?.amount, tokenDecimals]);

  useEffect(() => {
    const cleanAmount = amountIn.trim();
    if (!validAmount(cleanAmount, side === 'buy' ? quoteDecimals : tokenDecimals)) {
      setQuote(null);
      setQuoteError('');
      setQuoteLoading(false);
      return;
    }

    setQuote(null);
    setQuoteError('');

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setQuoteLoading(true);
      setQuoteError('');
      const query = new URLSearchParams({
        mintAddress,
        side,
        amountIn: cleanAmount,
        slippageBps: String(slippageBps),
      });
      try {
        const response = await fetch(`${apiUrl}/api/swap/quote?${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || t('No pudimos cotizar este intercambio.'));
        setQuote(data.quote as SwapQuote);
      } catch (error) {
        if (controller.signal.aborted) return;
        setQuote(null);
        const message = userFacingError(error, t('No pudimos cotizar este intercambio.'), t);
        setQuoteError(message);
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    }, 450);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [amountIn, mintAddress, quoteDecimals, tokenDecimals, side, slippageBps, refreshVersion, t]);

  const handleSwap = async () => {
    if (swapLoading || !walletAddress || !publicKey || !signTransaction || !isIdentified) return;
    if (!validAmount(amountIn.trim(), side === 'buy' ? quoteDecimals : tokenDecimals)) {
      setQuoteError(t('Escribe una cantidad válida con la precisión permitida para este activo.'));
      return;
    }

    setSwapLoading(true);
    setOperationStage('preparing');
    setSignature('');
    setSignatureWallet('');
    setConfirmed(false);
    setSwapFailed(false);
    setHistoryRecordPending(false);
    try {
      const response = await fetch(`${apiUrl}/api/swap/prepare`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userWallet: walletAddress,
          mintAddress,
          side,
          amountIn: amountIn.trim(),
          slippageBps,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || t('No pudimos preparar el intercambio.'));
      if (typeof data.transaction !== 'string'
        || typeof data.transactionMessageHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(data.transactionMessageHash)
        || !Number.isSafeInteger(data.lastValidBlockHeight)
        || data.lastValidBlockHeight <= 0
        || !data.quote
        || typeof data.quote.amountOut !== 'string'
        || typeof data.quote.minimumAmountOut !== 'string'
        || (data.quote.maximumAmountIn !== null && typeof data.quote.maximumAmountIn !== 'string')
        || typeof data.quote.inputMint !== 'string'
        || typeof data.quote.outputMint !== 'string'
        || typeof data.quote.quoteMint !== 'string'
        || !Number.isInteger(data.quote.quoteDecimals)) {
        throw new Error(t('El servidor devolvió una transacción incompleta. Vuelve a cotizar.'));
      }
      const preparedQuote = data.quote as SwapQuote;
      const expectedInputMint = side === 'buy' ? quoteMint : mintAddress;
      const expectedOutputMint = side === 'buy' ? mintAddress : quoteMint;
      if (preparedQuote.side !== side
        || preparedQuote.quoteMint !== quoteMint
        || preparedQuote.quoteDecimals !== quoteDecimals
        || preparedQuote.inputMint !== expectedInputMint
        || preparedQuote.outputMint !== expectedOutputMint) {
        throw new Error(t('La cotización preparada no coincide con el token y sentido elegidos.'));
      }
      if (quote && !matchesReviewedQuote(quote, preparedQuote)) {
        setQuote(preparedQuote);
        setQuoteError('');
        throw new Error(t('La cotización cambió. Revisa los importes actualizados antes de volver a firmar.'));
      }

      const { Transaction } = await import('@solana/web3.js');
      const tx = Transaction.from(Buffer.from(data.transaction, 'base64'));
      const blockhash = tx.recentBlockhash;
      if (!tx.feePayer?.equals(publicKey) || !blockhash) {
        throw new Error(t('La transacción preparada no corresponde a esta wallet. Vuelve a cotizar.'));
      }
      const preparedHash = await hashMessage(tx.compileMessage().serialize());
      if (preparedHash !== data.transactionMessageHash) {
        throw new Error(t('La transacción recibida no coincide con la preparada. No se enviará.'));
      }

      if (side === 'sell') {
        await ensureTokenInputBalance(connection, publicKey, mintAddress, preparedQuote.amountIn, tokenDecimals);
      } else if (quoteMint !== solMint) {
        await ensureTokenInputBalance(connection, publicKey, quoteMint, preparedQuote.maximumAmountIn ?? preparedQuote.amountIn, quoteDecimals);
      }
      const feeEstimate = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
      const walletBalance = await connection.getBalance(publicKey, 'confirmed');
      if (feeEstimate.value === null) throw new Error(t('No se pudo estimar la comisión de red.'));
      const reserveLamports = BigInt(feeEstimate.value) + (side === 'buy' && quoteMint === solMint ? 10_000_000n : 2_000_000n);
      const nativeInputLamports = side === 'buy' && quoteMint === solMint
        ? parseAmountRaw(preparedQuote.maximumAmountIn ?? preparedQuote.amountIn, 9)
        : 0n;
      if (BigInt(walletBalance) < nativeInputLamports + reserveLamports) {
        throw new Error(t(side === 'buy' && quoteMint === solMint
          ? 'El saldo SOL no alcanza para el importe y la reserva de comisiones estimados.'
          : 'El saldo SOL no alcanza para la comisión de red.'));
      }

      setOperationStage('signature');
      const signed = await signTransaction(tx);
      const signedHash = await hashMessage(signed.compileMessage().serialize());
      if (signedHash !== preparedHash) {
        throw new Error(t('La wallet modificó el mensaje al firmar. No se envió el intercambio.'));
      }

      const walletSignature = signed.signatures.find((entry) => entry.publicKey.equals(publicKey))?.signature;
      if (!walletSignature) throw new Error(t('No se pudo preparar la firma local. No se enviará el intercambio.'));
      const expectedSignature = bs58.encode(walletSignature);
      setSignature(expectedSignature);
      setSignatureWallet(walletAddress);

      setOperationStage('sending');
      const txSignature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
      if (txSignature !== expectedSignature) {
        throw new Error(t('La firma enviada no coincide con la firma local. Verifica su estado antes de continuar.'));
      }
      setOperationStage('confirming');
      const confirmation = await connection.confirmTransaction({
        signature: txSignature,
        blockhash,
        lastValidBlockHeight: data.lastValidBlockHeight,
      }, 'confirmed');
      if (confirmation.value.err) {
        setSwapFailed(true);
        throw new Error(t('La transacción fue enviada, pero Solana la marcó como fallida.'));
      }
      setConfirmed(true);
      setAmountIn('');
      let recorded = false;
      for (let attempt = 0; attempt < 3 && !recorded; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, attempt * 700));
        try {
          const recordResponse = await fetch(`${apiUrl}/api/swap/record`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userWallet: walletAddress, mintAddress, side, signature: txSignature }),
          });
          const recordData = await recordResponse.json();
          if (!recordResponse.ok || !recordData.success) throw new Error(recordData.error || t('No se pudo guardar esta operación en el historial.'));
          recorded = recordData.recorded === true;
        } catch {
          // The on-chain swap is already confirmed; history indexing can be retried separately.
          break;
        }
      }
      setHistoryRecordPending(!recorded);
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      notifyToast({
        title: t(side === 'buy' ? 'Compra confirmada en Devnet' : 'Venta confirmada en Devnet'),
        message: recorded ? t('La operación quedó confirmada y guardada en tu historial.') : t('La operación quedó confirmada. El historial puede tardar en actualizarse.'),
      });
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      const message = userFacingError(error, t('No se pudo completar el intercambio.'), t);
      notifyToast({ title: t('No se pudo completar el intercambio'), message });
      if (signature) setConfirmed(false);
    } finally {
      setSwapLoading(false);
      setOperationStage(null);
    }
  };

  const inputSymbol = side === 'buy' ? quoteSymbol : tokenSymbol;
  const outputSymbol = side === 'buy' ? tokenSymbol : quoteSymbol;
  const pendingSignature = Boolean(signature && !confirmed && !swapFailed);
  const canSwap = Boolean(quote && !quoteLoading && !quoteError && !swapLoading && isIdentified && !pendingSignature);

  const retryHistoryRecord = async () => {
    if (!signature || !signatureWallet || !historyRecordPending || historyRetrying) return;
    setHistoryRetrying(true);
    try {
      const response = await fetch(`${apiUrl}/api/swap/record`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userWallet: signatureWallet, mintAddress, side, signature }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || data.recorded !== true) throw new Error(data.error || t('Solana aún no termina de indexar esta operación.'));
      setHistoryRecordPending(false);
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      notifyToast({ title: t('Historial actualizado'), message: t('El swap verificado ya aparece en tu historial.') });
    } catch (error) {
      const message = userFacingError(error, t('Solana aún no termina de indexar esta operación.'), t);
      notifyToast({ title: t('El historial sigue pendiente'), message });
    } finally {
      setHistoryRetrying(false);
    }
  };

  const verifyPendingSignature = async () => {
    if (!signature || !signatureWallet || !pendingSignature || signatureChecking) return;
    setSignatureChecking(true);
    try {
      const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = response.value[0];
      if (!status) {
        notifyToast({ title: t('Enviada; revisa Explorer antes de intentar otra vez'), message: t('No se encontró confirmación para esta firma en Devnet. Wire no la reenviará; consulta Explorer y vuelve a verificar más tarde.') });
        return;
      }
      if (status.err) {
        setSwapFailed(true);
        setConfirmed(false);
        notifyToast({ title: t('Falló en Devnet; ya puedes revisar otra cotización'), message: t('La transacción falló en Devnet. Revisa la firma antes de preparar otra operación.') });
        return;
      }
      const confirmedOnChain = status.confirmationStatus === 'confirmed'
        || status.confirmationStatus === 'finalized'
        || status.confirmations === null
        || (status.confirmations ?? 0) > 0;
      if (!confirmedOnChain) {
        notifyToast({ title: t('Enviada; revisa Explorer antes de intentar otra vez'), message: t('La firma aún no tiene confirmación en Devnet. Wire no la reenviará; vuelve a verificar más tarde.') });
        return;
      }

      setConfirmed(true);
      setSwapFailed(false);
      setAmountIn('');
      let recorded = false;
      try {
        const recordResponse = await fetch(`${apiUrl}/api/swap/record`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userWallet: signatureWallet, mintAddress, side, signature }),
        });
        const recordData = await recordResponse.json();
        recorded = recordResponse.ok && recordData.success && recordData.recorded === true;
      } catch { recorded = false; }
      setHistoryRecordPending(!recorded);
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      notifyToast({
        title: t('Historial actualizado'),
        message: recorded ? t('El swap verificado ya aparece en tu historial.') : t('Transacción confirmada. Estamos esperando los datos del historial de Solana.'),
      });
      setRefreshVersion((version) => version + 1);
    } catch {
      notifyToast({ title: t('Enviada; revisa Explorer antes de intentar otra vez'), message: t('No se pudo consultar la firma en Devnet. Inténtalo más tarde.') });
    } finally { setSignatureChecking(false); }
  };

  return (
    <>
    <section id="token-swap-panel" className="wire-panel mt-6 rounded-2xl p-5 sm:p-6" aria-labelledby="swap-title">
      <div className="wire-panel-topline">
        <span>{t('INTERCAMBIO · DEVNET')}</span>
        <button
          type="button"
          onClick={() => setRefreshVersion((version) => version + 1)}
          disabled={quoteLoading || swapLoading || pendingSignature || !validAmount(amountIn.trim(), side === 'buy' ? quoteDecimals : tokenDecimals)}
          className="wire-button wire-button-quiet min-h-11 px-2 text-xs"
          aria-label={t('Actualizar cotización')}
        >
          <RefreshCw size={14} aria-hidden="true" className={quoteLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <h3 id="swap-title" className="mt-4 font-display text-xl font-semibold">{t('Compra y venta')}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
        {t(launchPlatform === 'PUMP_FUN'
          ? 'Wire intercambia en la curva de Pump.fun hasta la graduación y luego detecta la pool PumpSwap. Revisa el mercado y el mensaje de tu wallet antes de firmar.'
          : 'Intercambia el token con su pool CPMM de Raydium. Revisa la cotización y el mensaje de tu wallet antes de firmar.')}
      </p>

      <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed text-[var(--muted)]">
        {t(launchPlatform === 'PUMP_FUN'
          ? 'El creador no necesita comprar su propio token. Esta pantalla permite intercambiar SOL y tokens en el mercado activo de Pump.fun.'
          : 'El creador no necesita comprar su propio token. Esta pantalla permite intercambiar {asset} y tokens usando la liquidez de la pool.', { asset: quoteSymbol })}
      </p>

      <details className="group mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold marker:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wire-green)]">
          <CircleHelp size={16} aria-hidden="true" className="shrink-0 text-[var(--wire-green)]" />
          {t('Guía: cómo funciona y qué revisar')}
          <ChevronDown size={16} aria-hidden="true" className="ml-auto shrink-0 text-[var(--muted)] transition-transform group-open:rotate-180" />
        </summary>
        <ul className="mt-2 space-y-2 border-t border-[var(--line)] pt-3 text-xs leading-relaxed text-[var(--muted)]">
          <li>{t(launchPlatform === 'PUMP_FUN'
            ? 'Antes de graduarse, compras y vendes en la curva de Pump.fun. Después, Wire cambia a PumpSwap; la cotización indica qué mercado está activo.'
            : 'Al comprar, entregas {asset} a la pool y recibes tokens. Al vender, entregas tokens a la pool y recibes {asset}.', { asset: quoteSymbol })}</li>
          <li>{t('Una compra propia es opcional: solo comprueba el flujo de intercambio; no demuestra interés de otros usuarios ni garantiza el precio.')}</li>
          <li>{t(launchPlatform === 'PUMP_FUN' && side === 'buy'
            ? 'En compras de Pump.fun y PumpSwap, la cotización fija los tokens objetivo; el deslizamiento amplía el máximo SOL que puede cobrar la transacción. Revisa ese límite antes de firmar.'
            : 'El deslizamiento protege la cotización: en una venta o compra de Raydium fija el mínimo que aceptas recibir. Una tolerancia baja puede hacer fallar el intercambio.')}</li>
          <li>{t(launchPlatform === 'PUMP_FUN'
            ? 'Antes de firmar, revisa el mercado activo, el mínimo recibido, las comisiones, el impacto y el deslizamiento. Phantom muestra aparte el fee de red.'
            : 'Antes de firmar, revisa el mínimo recibido, el fee del pool, el impacto y el deslizamiento. Phantom muestra aparte el fee de red.')}</li>
          <li>{t(launchPlatform === 'PUMP_FUN'
            ? 'Wire opera en Devnet: SOL y tokens de prueba no tienen valor real. Cada operación confirmada cambia las reservas del mercado activo.'
            : 'Wire opera en Devnet: {asset} y tokens de prueba no tienen valor real. Cada operación confirmada cambia las reservas de la pool.', { asset: quoteSymbol })}</li>
        </ul>
      </details>

      <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1" role="group" aria-label={t('Tipo de intercambio')}>
        {(['buy', 'sell'] as const).map((nextSide) => (
          <button
            key={nextSide}
            type="button"
            onClick={() => { setSide(nextSide); setSignature(''); setSignatureWallet(''); setConfirmed(false); setSwapFailed(false); setHistoryRecordPending(false); }}
            disabled={swapLoading || pendingSignature || historyRecordPending}
            aria-pressed={side === nextSide}
            className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors ${side === nextSide ? 'bg-[var(--wire-green)] text-[#071008]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'}`}
          >
            {t(nextSide === 'buy' ? 'Comprar' : 'Vender')}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <label htmlFor="swap-amount" className="block text-xs font-medium text-[var(--muted)]">{t('Entregas')}</label>
        <div className="mt-2 flex items-center gap-3">
          <input
            id="swap-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            value={amountIn}
            onChange={(event) => setAmountIn(event.target.value)}
            disabled={swapLoading || pendingSignature}
            placeholder="0.00"
            aria-describedby="swap-amount-help"
            className="wire-input min-w-0 flex-1 rounded-lg px-3 font-mono text-lg"
          />
          <span className="font-mono text-sm font-semibold">{inputSymbol}</span>
        </div>
        <p id="swap-amount-help" className="mt-2 text-xs text-[var(--muted)]">{t('Usa hasta {decimals} decimales para este monto. La wallet debe tener saldo suficiente y SOL para la comisión de red.', { decimals: side === 'buy' ? quoteDecimals : tokenDecimals })}</p>
      </div>

      <div className="my-2 flex justify-center text-[var(--muted)]" aria-hidden="true"><ArrowDownUp size={17} /></div>

      <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <div className="flex min-w-0 items-start justify-between gap-3 text-xs text-[var(--muted)]">
          <span>{t('Recibes estimado')}</span>
          <span className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{outputSymbol}</span>
        </div>
        <div className="mt-2 min-h-8 min-w-0 font-mono text-lg font-semibold [overflow-wrap:anywhere]" aria-live="polite">
          {quoteLoading ? <span className="text-sm text-[var(--muted)]">{t('Cotizando…')}</span> : quote ? `${quote.amountOut} ${quote.outputSymbol}` : '—'}
        </div>
        {quote ? (
          <dl className="mt-4 min-w-0 space-y-2 border-t border-[var(--line)] pt-3 text-xs">
            <div className="flex min-w-0 justify-between gap-3"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Mercado activo')}</dt><dd className="min-w-0 text-right [overflow-wrap:anywhere]">{t(quote.venue === 'PUMP_SWAP' ? 'PumpSwap' : quote.venue === 'PUMP_FUN' ? 'Pump.fun · bonding curve' : 'Raydium CPMM')} <a href={explorerAddress(quote.poolAddress)} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center text-[var(--wire-green)]">{t('Ver mercado')} <ExternalLink size={11} aria-hidden="true" /></a></dd></div>
            <div className="flex min-w-0 justify-between gap-3"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t(quote.side === 'buy' && quote.venue !== 'RAYDIUM' ? 'Cantidad objetivo recibida' : 'Mínimo recibido')}</dt><dd className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{quote.minimumAmountOut} {quote.outputSymbol}</dd></div>
            {quote.side === 'buy' && <div className="flex min-w-0 justify-between gap-3"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Máximo a pagar')}</dt><dd className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{quote.maximumAmountIn ?? quote.amountIn} {quote.inputSymbol}</dd></div>}
            {quote.side === 'buy' && <p className="text-xs leading-relaxed text-[var(--muted)]">{t('El límite incluye los fees del mercado; el fee de red se cobra aparte.')}</p>}
            <div className="flex min-w-0 justify-between gap-3"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t(feeLabel)}</dt><dd className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{quote.estimatedPoolFee} {quote.inputSymbol}</dd></div>
            <div className="flex min-w-0 justify-between gap-3"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Impacto de precio (sin fee del pool)')}</dt><dd className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{quote.priceImpactPercent === null ? '—' : `${quote.priceImpactPercent}%`}</dd></div>
            <div className="flex min-w-0 justify-between gap-3"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Tolerancia al deslizamiento')}</dt><dd className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{(slippageBps / 100).toFixed(2)}%</dd></div>
          </dl>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" aria-label={t('Tolerancia al deslizamiento')}>
        <span className="mr-1 text-xs text-[var(--muted)]">{t('Tolerancia al deslizamiento')}</span>
        {[50, 100, 200, 500].map((bps) => (
          <button
            key={bps}
            type="button"
            onClick={() => setSlippageBps(bps)}
            disabled={swapLoading || pendingSignature}
            aria-pressed={slippageBps === bps}
            className={`min-h-11 rounded-lg border px-3 text-xs font-mono ${slippageBps === bps ? 'border-[var(--wire-green)] bg-[var(--wire-green-dim)] text-[var(--wire-green)]' : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)]'}`}
          >
            {(bps / 100).toFixed(2)}%
          </button>
        ))}
      </div>

      {quoteError ? <p className="mt-3 text-sm text-[var(--danger)]" role="status">{t(quoteError)}</p> : null}

      {!walletAddress ? (
        <button type="button" onClick={() => setWalletModalVisible(true)} className="wire-button wire-button-primary mt-5 w-full justify-center">{t('Conecta tu wallet para intercambiar')}</button>
      ) : !isIdentified ? (
        <button
          type="button"
          onClick={() => void identifyWallet().catch((error) => notifyToast({ title: t('No se pudo identificar la wallet'), message: userFacingError(error, t('Inténtalo de nuevo.'), t) }))}
          className="wire-button wire-button-primary mt-5 w-full justify-center"
        >{t('Identifica tu wallet')}</button>
      ) : (
        <button type="button" onClick={() => void handleSwap()} disabled={!canSwap} className="wire-button wire-button-primary mt-5 w-full justify-center disabled:cursor-not-allowed disabled:opacity-50">
          {operationStage === 'preparing' ? t('Preparando intercambio…')
            : operationStage === 'signature' ? t('Esperando firma en tu wallet…')
              : operationStage === 'sending' ? t('Enviando a Devnet…')
                : operationStage === 'confirming' ? t('Confirmando en Devnet…')
                  : t(side === 'buy' ? 'Comprar {symbol}' : 'Vender {symbol}', { symbol: tokenSymbol })}
        </button>
      )}

      <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
        {t(launchPlatform === 'PUMP_FUN'
          ? 'El mercado y la cotización pueden cambiar antes de firmar. El fee de red se cobra aparte y aparecerá en tu wallet. Wire solo está conectado a Devnet.'
          : 'Las cotizaciones cambian con la pool. El fee de red se cobra aparte y aparecerá en tu wallet. Wire solo está conectado a Devnet.')}
      </p>

      {signature ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3" role="status">
          <span className={confirmed ? 'text-sm text-[var(--success)]' : swapFailed ? 'text-sm text-[var(--danger)]' : 'text-sm text-[var(--muted)]'}>
            {confirmed ? t('Confirmado en Devnet') : swapFailed ? t('Falló en Devnet; ya puedes revisar otra cotización') : t('Enviada; revisa Explorer antes de intentar otra vez')}
          </span>
          <a href={SOLANA_EXPLORER_TX(signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">
            {t('Ver en Explorer')} <ExternalLink size={13} aria-hidden="true" />
          </a>
          {pendingSignature ? <button type="button" onClick={() => void verifyPendingSignature()} disabled={signatureChecking} className="wire-button wire-button-quiet min-h-11 px-3 text-xs">{t('Verificar estado en Devnet')}</button> : null}
        </div>
      ) : null}
      {confirmed && historyRecordPending ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]" role="status">
          <span>{t('Transacción confirmada. Estamos esperando los datos del historial de Solana.')}</span>
          <button type="button" onClick={() => void retryHistoryRecord()} disabled={historyRetrying} className="wire-button wire-button-quiet min-h-11 px-2 text-xs disabled:opacity-60">
            {historyRetrying ? t('Reintentando…') : t('Reintentar historial')}
          </button>
        </div>
      ) : null}
    </section>
    <ProjectWalletSwapPanel mintAddress={mintAddress} tokenSymbol={tokenSymbol} quoteMint={quoteMint} launchPlatform={launchPlatform} />
    </>
  );
}
