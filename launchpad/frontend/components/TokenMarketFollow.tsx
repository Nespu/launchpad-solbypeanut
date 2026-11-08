'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useWireLocale } from './LocaleProvider';
import { userFacingError } from './toastEvents';
import TokenSellAlert from './TokenSellAlert';

type MarketQuote = {
  venue: 'RAYDIUM' | 'PUMP_FUN' | 'PUMP_SWAP';
  poolAddress: string;
  inputMint: string;
  outputMint: string;
  quoteMint: string;
  inputSymbol: string;
  outputSymbol: string;
  amountIn: string;
  amountOut: string;
  estimatedPoolFee: string;
  priceImpactPercent: string | null;
  network: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function formatNumber(value: number, locale: 'es' | 'en') {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', {
    maximumSignificantDigits: 8,
  }).format(value);
}

export default function TokenMarketFollow({
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
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const translateRef = useRef(t);
  const requestInFlight = useRef(false);

  useEffect(() => { translateRef.current = t; }, [t]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const inputAmount = quoteMint === SOL_MINT ? '0.01' : '1';
    setQuote(null);
    setError('');
    setLastUpdated(null);

    const refresh = async () => {
      if (requestInFlight.current || document.visibilityState === 'hidden') return;
      requestInFlight.current = true;
      setLoading(true);
      try {
        const query = new URLSearchParams({
          mintAddress,
          side: 'buy',
          amountIn: inputAmount,
          slippageBps: '0',
        });
        const response = await fetch(`${API_URL}/api/swap/quote?${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok || !data.success || !data.quote) {
          throw new Error(data.error || translateRef.current('No hay una cotización disponible ahora.'));
        }

        const nextQuote = data.quote as MarketQuote;
        if (nextQuote.network !== 'Solana Devnet'
          || !['RAYDIUM', 'PUMP_FUN', 'PUMP_SWAP'].includes(nextQuote.venue)
          || typeof nextQuote.poolAddress !== 'string'
          || !nextQuote.poolAddress
          || nextQuote.inputMint !== quoteMint
          || nextQuote.outputMint !== mintAddress
          || nextQuote.quoteMint !== quoteMint
          || nextQuote.inputSymbol !== (quoteMint === SOL_MINT ? 'SOL' : 'USDC')
          || nextQuote.outputSymbol !== tokenSymbol
          || typeof nextQuote.amountIn !== 'string'
          || typeof nextQuote.amountOut !== 'string'
          || !Number.isFinite(Number(nextQuote.amountIn))
          || !Number.isFinite(Number(nextQuote.amountOut))
          || Number(nextQuote.amountIn) <= 0
          || Number(nextQuote.amountOut) <= 0
          || !Number.isFinite(Number(nextQuote.estimatedPoolFee))
          || (nextQuote.priceImpactPercent !== null && !Number.isFinite(Number(nextQuote.priceImpactPercent)))) {
          throw new Error(translateRef.current('La respuesta del mercado no es válida.'));
        }

        if (active) {
          setQuote(nextQuote);
          setError('');
          setLastUpdated(Date.now());
        }
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        setQuote(null);
        setError(userFacingError(
          caught,
          translateRef.current('No hay una cotización disponible ahora.'),
          translateRef.current,
        ));
      } finally {
        requestInFlight.current = false;
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
      requestInFlight.current = false;
    };
  }, [mintAddress, quoteMint, tokenSymbol, refreshNonce]);

  const marketName = quote?.venue === 'PUMP_FUN'
    ? t('Pump.fun · bonding curve')
    : quote?.venue === 'PUMP_SWAP'
      ? t('PumpSwap')
      : quote?.venue === 'RAYDIUM'
        ? t('Raydium CPMM')
        : t('Sin cotización');
  const impliedUnitPrice = quote
    ? Number(quote.amountIn) / Number(quote.amountOut)
    : 0;
  const lastUpdatedLabel = lastUpdated === null
    ? ''
    : new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(lastUpdated);

  return (
    <section className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5" aria-labelledby="market-follow-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="wire-kicker mb-2">{t('SEGUIMIENTO DE MERCADO · DEVNET')}</div>
          <h3 id="market-follow-title" className="font-display text-lg font-semibold">{t('Seguimiento del mercado')}</h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-[var(--muted)]">
            {t('Cotiza una compra pequeña para detectar el mercado activo. Se actualiza cada 30 segundos.')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshNonce((value) => value + 1)}
          disabled={loading}
          className="wire-button wire-button-secondary min-h-11 px-3 text-xs disabled:opacity-60"
          aria-label={t('Actualizar mercado')}
        >
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
          {t('Actualizar mercado')}
        </button>
      </div>

      {quote ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
            <span className="text-xs text-[var(--muted)]">{t('Mercado activo')}</span>
            <div className="mt-1 font-semibold">{marketName}</div>
          </div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
            <span className="text-xs text-[var(--muted)]">{t('Cotización de compra')}</span>
            <div className="mt-1 font-mono text-sm">
              {quote.amountIn} {quote.inputSymbol} → {quote.amountOut} {tokenSymbol}
            </div>
            <div className="mt-1 text-xs text-[var(--muted)]">
              {t('Precio promedio de la cotización')}: {formatNumber(impliedUnitPrice, locale)} {quote.inputSymbol}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
            <span className="text-xs text-[var(--muted)]">{t('Fee estimado del mercado')}</span>
            <div className="mt-1 font-mono text-sm">{quote.estimatedPoolFee} {quote.inputSymbol}</div>
          </div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
            <span className="text-xs text-[var(--muted)]">{t('Impacto de precio')}</span>
            <div className="mt-1 font-mono text-sm">
              {quote.priceImpactPercent === null ? '—' : `${quote.priceImpactPercent}%`}
            </div>
          </div>
        </div>
      ) : loading ? (
        <p className="mt-4 text-sm text-[var(--muted)]" role="status">{t('Consultando el mercado en Devnet…')}</p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-[var(--danger)]" role="status">{error}</p> : null}
      {quote ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">
          <span>{lastUpdatedLabel ? t('Actualizado {time}', { time: lastUpdatedLabel }) : t('Actualización pendiente')}</span>
          <a
            href={`https://explorer.solana.com/address/${encodeURIComponent(quote.poolAddress)}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="wire-button wire-button-quiet min-h-11 px-2 text-xs"
          >
            {t('Ver mercado en Explorer')} <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
        {t('Es una cotización de ejemplo basada en el estado actual de Devnet, no un precio histórico ni una garantía de ejecución. La cotización puede cambiar antes de firmar.')}
      </p>
      <TokenSellAlert
        mintAddress={mintAddress}
        tokenSymbol={tokenSymbol}
        quoteMint={quoteMint}
        launchPlatform={launchPlatform}
        onReviewSell={onReviewSell}
      />
    </section>
  );
}
