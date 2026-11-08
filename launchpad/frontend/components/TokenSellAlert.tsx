'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useWireLocale } from './LocaleProvider';
import { userFacingError } from './toastEvents';
import {
  isPositiveDecimalAmount,
  parseTokenSellAlert,
  serializeTokenSellAlert,
  shouldTriggerTokenSellAlert,
  tokenSellAlertStorageKey,
  type TokenSellAlert,
  type TokenSellAlertContext,
} from '../lib/tokenSellAlert';

type SellQuote = {
  venue: 'RAYDIUM' | 'PUMP_FUN' | 'PUMP_SWAP';
  poolAddress: string;
  side: 'sell';
  inputMint: string;
  outputMint: string;
  quoteMint: string;
  inputSymbol: string;
  outputSymbol: string;
  quoteDecimals: number;
  amountIn: string;
  amountOut: string;
  estimatedPoolFee: string;
  priceImpactPercent: string | null;
  network: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function sameRawAmount(left: string, right: string, decimals: number): boolean {
  const parse = (value: string) => {
    if (!isPositiveDecimalAmount(value, decimals)) return null;
    const [whole, fraction = ''] = value.trim().split('.');
    return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
  };
  const leftRaw = parse(left);
  const rightRaw = parse(right);
  return leftRaw !== null && leftRaw === rightRaw;
}

export default function TokenSellAlert({
  mintAddress,
  tokenSymbol,
  quoteMint,
  launchPlatform,
  onReviewSell,
}: {
  mintAddress: string;
  tokenSymbol: string;
  quoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  onReviewSell?: (amount: string) => void;
}) {
  const { locale, t } = useWireLocale();
  const tokenDecimals = launchPlatform === 'PUMP_FUN' ? 6 : 9;
  const quoteDecimals = quoteMint === SOL_MINT ? 9 : 6;
  const quoteSymbol = quoteMint === SOL_MINT ? 'SOL' : 'USDC';
  const context: TokenSellAlertContext = { mintAddress, quoteMint, tokenDecimals, quoteDecimals };
  const storageKey = tokenSellAlertStorageKey(context);
  const [loadedKey, setLoadedKey] = useState('');
  const [monitor, setMonitor] = useState<TokenSellAlert | null>(null);
  const [amountIn, setAmountIn] = useState('');
  const [minimumAmountOut, setMinimumAmountOut] = useState('');
  const [quote, setQuote] = useState<SellQuote | null>(null);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    setLoadedKey('');
    setQuote(null);
    setError('');
    setStorageError(false);
    setLastUpdated(null);
    let saved: TokenSellAlert | null = null;
    try {
      saved = parseTokenSellAlert(window.localStorage.getItem(storageKey), context);
    } catch {
      setStorageError(true);
    }
    setMonitor(saved);
    setAmountIn(saved?.amountIn ?? '');
    setMinimumAmountOut(saved?.minimumAmountOut ?? '');
    setLoadedKey(storageKey);
  }, [mintAddress, quoteMint, tokenDecimals, quoteDecimals, storageKey]);

  useEffect(() => {
    if (loadedKey !== storageKey) return;
    try {
      if (!monitor) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      const serialized = serializeTokenSellAlert(monitor, context);
      if (serialized) window.localStorage.setItem(storageKey, serialized);
    } catch {
      setStorageError(true);
    }
  }, [loadedKey, storageKey, monitor, mintAddress, quoteMint, tokenDecimals, quoteDecimals]);

  useEffect(() => {
    if (loadedKey !== storageKey || !monitor || monitor.status !== 'armed') {
      setLoading(false);
      return;
    }

    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams({
          mintAddress,
          side: 'sell',
          amountIn: monitor.amountIn,
          slippageBps: '0',
        });
        const response = await fetch(API_URL + '/api/swap/quote?' + query.toString(), {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok || !data.success || !data.quote) {
          throw new Error(data.error || t('No se pudo cotizar la venta ahora.'));
        }

        const nextQuote = data.quote as SellQuote;
        if (nextQuote.side !== 'sell'
          || nextQuote.network !== 'Solana Devnet'
          || !['RAYDIUM', 'PUMP_FUN', 'PUMP_SWAP'].includes(nextQuote.venue)
          || typeof nextQuote.poolAddress !== 'string' || !nextQuote.poolAddress
          || nextQuote.inputMint !== mintAddress
          || nextQuote.outputMint !== quoteMint
          || nextQuote.quoteMint !== quoteMint
          || nextQuote.quoteDecimals !== quoteDecimals
          || nextQuote.inputSymbol !== tokenSymbol
          || nextQuote.outputSymbol !== quoteSymbol
          || typeof nextQuote.amountIn !== 'string'
          || !sameRawAmount(nextQuote.amountIn, monitor.amountIn, tokenDecimals)
          || typeof nextQuote.amountOut !== 'string'
          || !isPositiveDecimalAmount(nextQuote.amountOut, quoteDecimals)
          || !Number.isFinite(Number(nextQuote.estimatedPoolFee))
          || (nextQuote.priceImpactPercent !== null && !Number.isFinite(Number(nextQuote.priceImpactPercent)))) {
          throw new Error(t('La respuesta de la cotización de venta no es válida.'));
        }

        if (active) {
          setQuote(nextQuote);
          setLastUpdated(Date.now());
          setError('');
          if (shouldTriggerTokenSellAlert(nextQuote.amountOut, monitor.minimumAmountOut, quoteDecimals)) {
            setMonitor({ ...monitor, status: 'triggered', triggeredAt: Date.now() });
          }
        }
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        setError(userFacingError(caught, t('No se pudo cotizar la venta ahora.'), t));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };

    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadedKey, storageKey, mintAddress, quoteMint, tokenSymbol, quoteSymbol, tokenDecimals, quoteDecimals, monitor, refreshNonce, t]);

  const validDraft = isPositiveDecimalAmount(amountIn.trim(), tokenDecimals)
    && isPositiveDecimalAmount(minimumAmountOut.trim(), quoteDecimals);
  const armed = monitor?.status === 'armed';
  const triggered = monitor?.status === 'triggered';
  const sellMarketName = quote?.venue === 'PUMP_FUN'
    ? t('Pump.fun · bonding curve')
    : quote?.venue === 'PUMP_SWAP'
      ? t('PumpSwap')
      : quote?.venue === 'RAYDIUM'
        ? t('Raydium CPMM')
        : '';
  const lastUpdatedLabel = lastUpdated === null
    ? ''
    : new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(lastUpdated);

  const handleAction = () => {
    if (armed) {
      setMonitor(null);
      setQuote(null);
      setError('');
      setLastUpdated(null);
      return;
    }
    if (!validDraft) return;
    setStorageError(false);
    setError('');
    setQuote(null);
    setLastUpdated(null);
    setMonitor({
      amountIn: amountIn.trim(),
      minimumAmountOut: minimumAmountOut.trim(),
      status: 'armed',
    });
  };

  return (
    <div className="mt-5 border-t border-[var(--line)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold">{t('Aviso de objetivo de venta')}</h4>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
            {t('Wire cotiza cada 30 segundos mientras esta ficha está abierta y visible, y avisa si la venta del importe indicado alcanza tu objetivo. No firma ni vende; revisa manualmente la cotización antes de operar.')}
          </p>
        </div>
        {armed ? (
          <button
            type="button"
            onClick={() => setRefreshNonce((value) => value + 1)}
            disabled={loading}
            className="wire-button wire-button-secondary min-h-11 px-3 text-xs disabled:opacity-60"
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            {t('Comprobar ahora')}
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="block text-xs text-[var(--muted)]" htmlFor="sell-alert-amount">
          {t('Cantidad de {symbol} para cotizar', { symbol: tokenSymbol })}
          <input
            id="sell-alert-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amountIn}
            onChange={(event) => setAmountIn(event.target.value)}
            disabled={armed}
            className="wire-input mt-1 min-h-11 w-full text-sm text-[var(--text)] disabled:opacity-70"
            aria-describedby="sell-alert-amount-help"
          />
          <span id="sell-alert-amount-help" className="mt-1 block text-[var(--muted)]">
            {t('Hasta {decimals} decimales.', { decimals: tokenDecimals })}
          </span>
        </label>
        <label className="block text-xs text-[var(--muted)]" htmlFor="sell-alert-target">
            {t('Avisar si recibes al menos {symbol}', { symbol: quoteSymbol })}
          <input
            id="sell-alert-target"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={minimumAmountOut}
            onChange={(event) => setMinimumAmountOut(event.target.value)}
            disabled={armed}
            className="wire-input mt-1 min-h-11 w-full text-sm text-[var(--text)] disabled:opacity-70"
            aria-describedby="sell-alert-target-help"
          />
          <span id="sell-alert-target-help" className="mt-1 block text-[var(--muted)]">
            {t('Hasta {decimals} decimales.', { decimals: quoteDecimals })}
          </span>
        </label>
        <button
          type="button"
          onClick={handleAction}
          disabled={!armed && !validDraft}
          className="wire-button wire-button-primary min-h-11 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {armed ? t('Detener aviso') : triggered ? t('Armar otro aviso') : t('Activar aviso')}
        </button>
      </div>

      {armed ? (
        <p className="mt-3 text-xs text-[var(--muted)]" role="status">
          {t('Aviso activo: cotizando {amount} {token} para recibir al menos {target} {quote}.', {
            amount: monitor.amountIn,
            token: tokenSymbol,
            target: monitor.minimumAmountOut,
            quote: quoteSymbol,
          })}
        </p>
      ) : null}
      {triggered ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium text-[var(--success)]" role="alert">
            {quote
              ? t('Objetivo alcanzado: la cotización de venta llegó a {amount} {quote} o más. No se realizó ninguna venta; revisa manualmente Compra y venta.', {
                amount: quote.amountOut,
                quote: quoteSymbol,
              })
              : t('El objetivo se alcanzó en una cotización anterior. No se realizó ninguna venta; vuelve a cotizar antes de operar.')}
          </p>
          <button
            type="button"
            onClick={() => onReviewSell?.(monitor.amountIn)}
            disabled={!onReviewSell}
            className="wire-button wire-button-secondary min-h-11 px-3 text-xs disabled:opacity-60"
          >
            {t('Revisar venta en el panel')}
          </button>
        </div>
      ) : null}
      {quote ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-xs">
          <div className="space-y-1">
            <div className="font-mono">
              {t('Cotización de venta')}: {quote.amountIn} {tokenSymbol} → {quote.amountOut} {quoteSymbol}
            </div>
            <div className="text-[var(--muted)]">
              {t('Mercado activo')}: {sellMarketName} · {lastUpdatedLabel ? t('Actualizado {time}', { time: lastUpdatedLabel }) : t('Actualización pendiente')}
            </div>
          </div>
          <a
            href={'https://explorer.solana.com/address/' + encodeURIComponent(quote.poolAddress) + '?cluster=devnet'}
            target="_blank"
            rel="noreferrer"
            className="wire-button wire-button-quiet min-h-11 px-2 text-xs"
          >
            {t('Ver mercado en Explorer')} <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      ) : null}
      {loading && !quote ? <p className="mt-2 text-xs text-[var(--muted)]" role="status">{t('Cotizando venta en Devnet…')}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--danger)]" role="alert">{error}</p> : null}
      {storageError ? (
        <p className="mt-2 text-xs text-[var(--muted)]" role="status">
          {t('No se pudo guardar el aviso en este navegador; solo seguirá activo mientras esta ficha permanezca abierta.')}
        </p>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
        {t('La cotización es orientativa y puede cambiar. El aviso solo compara cantidades; no usa la bóveda ni solicita acceso a tu wallet.')}
      </p>
    </div>
  );
}
