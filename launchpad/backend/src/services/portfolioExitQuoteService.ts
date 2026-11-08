import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, bondingCurvePda } from '@pump-fun/pump-sdk';
import { PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk';
import { quoteRaydiumSwap } from './swapService';
import { quotePumpSwap } from './pumpAmmSwapService';
import { QUOTE_ASSETS, formatRawAmount, type QuoteAsset } from './poolQuoteAsset';
import { PublicError } from '../utils/publicError';
import { DEVNET_GENESIS_HASH } from '../utils/solanaNetwork';

const RAYDIUM_DEVNET_API = 'https://api-v3-devnet.raydium.io';
const POOL_PAGE_SIZE = 100;
const MAX_CANDIDATES_PER_QUOTE_ASSET = 3;

export type RaydiumPoolCandidate = {
  id: string;
  tvl: number;
};

type RaydiumQuote = Awaited<ReturnType<typeof quoteRaydiumSwap>>;
type QuoteFn = typeof quoteRaydiumSwap;
type PumpQuoteFn = typeof quotePumpSwap;

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAddress(value: unknown): string | null {
  if (!isRecord(value) || typeof value.address !== 'string') return null;
  try {
    return new PublicKey(value.address).toBase58();
  } catch {
    return null;
  }
}

function decimalToRaw(value: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const fraction = match[2] ?? '';
  return BigInt(match[1]) * 10n ** BigInt(decimals)
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Extract only live CPMM pool identifiers; API price fields are intentionally ignored. */
export function parseRaydiumDevnetCpmmCandidates(
  payload: unknown,
  tokenMint: string,
  quoteMint: string,
  pageSize = POOL_PAGE_SIZE,
): { candidates: RaydiumPoolCandidate[]; incomplete: boolean } {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw new Error('Raydium Devnet pool index returned an invalid response.');
  }
  const rows = payload.data.data;
  if (!Array.isArray(rows)) throw new Error('Raydium Devnet pool index returned an invalid pool list.');

  const unique = new Map<string, RaydiumPoolCandidate>();
  for (const row of rows) {
    if (!isRecord(row) || !Array.isArray(row.pooltype) || !row.pooltype.includes('Cpmm')) continue;
    const id = typeof row.id === 'string' ? row.id : '';
    const mintA = readAddress(row.mintA);
    const mintB = readAddress(row.mintB);
    const tvl = typeof row.tvl === 'number' && Number.isFinite(row.tvl) && row.tvl >= 0 ? row.tvl : 0;
    if (!id || !((mintA === tokenMint && mintB === quoteMint) || (mintB === tokenMint && mintA === quoteMint))) continue;
    let canonicalId: string;
    try {
      canonicalId = new PublicKey(id).toBase58();
    } catch {
      continue;
    }
    unique.set(canonicalId, { id: canonicalId, tvl });
  }

  const candidates = [...unique.values()].sort((left, right) => right.tvl - left.tvl);
  const hasNextPage = payload.data.hasNextPage === true || payload.data.hasNext === true;
  return { candidates, incomplete: hasNextPage || rows.length >= pageSize };
}

async function discoverCandidates(
  mintAddress: string,
  quoteAsset: QuoteAsset,
  fetcher: typeof fetch,
): Promise<{ candidates: RaydiumPoolCandidate[]; incomplete: boolean }> {
  const params = new URLSearchParams({
    page: '1',
    size: String(POOL_PAGE_SIZE),
    mint1: mintAddress,
    mint2: QUOTE_ASSETS[quoteAsset].mintAddress,
  });
  const response = await fetcher(`${RAYDIUM_DEVNET_API}/pools/info/list-v2?${params.toString()}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('Raydium Devnet pool discovery failed.');
  return parseRaydiumDevnetCpmmCandidates(await response.json(), mintAddress, QUOTE_ASSETS[quoteAsset].mintAddress);
}

async function discoverPumpMarket(connection: Connection, mint: PublicKey) {
  const curveAddress = bondingCurvePda(mint);
  const poolAddress = canonicalPumpPoolPda(mint, SOL_MINT);
  const [curveAccount, poolAccount] = await Promise.all([
    connection.getAccountInfo(curveAddress, 'confirmed'),
    connection.getAccountInfo(poolAddress, 'confirmed'),
  ]);
  if (curveAccount && !curveAccount.owner.equals(PUMP_PROGRAM_ID)) {
    return { curveAddress, available: false, incomplete: true };
  }
  if (poolAccount && !poolAccount.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    return { curveAddress, available: false, incomplete: true };
  }
  return { curveAddress, available: Boolean(curveAccount || poolAccount), incomplete: false };
}

export async function quotePortfolioExit(
  connection: Connection,
  mintInput: string,
  amountRawInput: string,
  dependencies: { fetcher?: typeof fetch; quote?: QuoteFn; pumpQuote?: PumpQuoteFn } = {},
) {
  let mintAddress: string;
  try {
    mintAddress = new PublicKey(mintInput).toBase58();
  } catch {
    throw new PublicError('La dirección del token no es válida.', 400);
  }
  if (!/^[1-9]\d{0,29}$/.test(amountRawInput)) {
    throw new PublicError('El balance del token no es válido.', 400);
  }
  const amountRaw = BigInt(amountRawInput);
  if (amountRaw <= 0n || amountRaw >= 10n ** 30n) {
    throw new PublicError('El balance del token está fuera del rango permitido.', 400);
  }
  if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
    throw new PublicError('La cotización de cartera solo está disponible en Solana Devnet.', 409);
  }

  const mintPublicKey = new PublicKey(mintAddress);
  const mintAccount = await connection.getAccountInfo(mintPublicKey, 'confirmed');
  if (!mintAccount || (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) && !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new PublicError('No se pudo validar este mint en Devnet.', 404);
  }
  let decimals: number;
  try {
    decimals = await getMint(connection, mintPublicKey, 'confirmed', mintAccount.owner).then((mint) => mint.decimals);
  } catch {
    throw new PublicError('No se pudieron leer los decimales del mint en Devnet.', 422);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new PublicError('Los decimales de este mint no son compatibles con las cotizaciones de Wire.', 422);
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const quote = dependencies.quote ?? quoteRaydiumSwap;
  const pumpQuote = dependencies.pumpQuote ?? quotePumpSwap;
  const discovery = await Promise.all((Object.keys(QUOTE_ASSETS) as QuoteAsset[]).map(async (quoteAsset) => {
    try {
      return { quoteAsset, ...await discoverCandidates(mintAddress, quoteAsset, fetcher) };
    } catch {
      return { quoteAsset, candidates: [] as RaydiumPoolCandidate[], incomplete: true };
    }
  }));

  const amountIn = formatRawAmount(amountRaw, decimals);
  const quotes: Array<{
    quoteMint: string;
    quoteSymbol: QuoteAsset;
    amountOut: string;
    amountOutRaw: string;
    quoteDecimals: number;
    minimumAmountOut: string;
    estimatedPoolFee: string;
    priceImpactPercent: string | null;
    poolAddress: string;
    venue: 'RAYDIUM' | 'PUMP_FUN' | 'PUMP_SWAP';
  }> = [];
  let discoveryIncomplete = false;
  let quoteAttemptsIncomplete = false;

  for (const result of discovery) {
    discoveryIncomplete ||= result.incomplete;
    const candidates = result.candidates.slice(0, MAX_CANDIDATES_PER_QUOTE_ASSET);
    if (result.candidates.length > candidates.length) quoteAttemptsIncomplete = true;
    let best: { candidate: RaydiumPoolCandidate; quote: RaydiumQuote } | null = null;
    for (const candidate of candidates) {
      try {
        const liveQuote: RaydiumQuote = await quote(connection, candidate.id, {
          mintAddress,
          side: 'sell',
          amountIn,
          slippageBps: 0,
        });
        if (liveQuote.outputMint !== QUOTE_ASSETS[result.quoteAsset].mintAddress) continue;
        const outputRaw = decimalToRaw(liveQuote.amountOut, liveQuote.quoteDecimals);
        const bestOutputRaw = best ? decimalToRaw(best.quote.amountOut, best.quote.quoteDecimals) : null;
        if (outputRaw !== null && (best === null || (bestOutputRaw !== null && outputRaw > bestOutputRaw))) {
          best = { candidate, quote: liveQuote };
        }
      } catch {
        // An indexed pool can be stale or unavailable on RPC. Try the next candidate.
        quoteAttemptsIncomplete = true;
      }
    }
    if (best) {
      const amountOutRaw = decimalToRaw(best.quote.amountOut, best.quote.quoteDecimals);
      if (amountOutRaw === null) {
        quoteAttemptsIncomplete = true;
        continue;
      }
      quotes.push({
        quoteMint: best.quote.quoteMint,
        quoteSymbol: result.quoteAsset,
        amountOut: best.quote.amountOut,
        amountOutRaw: amountOutRaw.toString(),
        quoteDecimals: best.quote.quoteDecimals,
        minimumAmountOut: best.quote.minimumAmountOut,
        estimatedPoolFee: best.quote.estimatedPoolFee,
        priceImpactPercent: best.quote.priceImpactPercent,
        poolAddress: best.candidate.id,
        venue: 'RAYDIUM',
      });
    }
  }

  // Pump.fun and PumpSwap use canonical mint-derived accounts, so no price index is needed.
  // Restrict discovery to Pump's Token-2022 six-decimal mint format and verify program owners.
  let pumpQuoteIncomplete = false;
  if (mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) && decimals === 6) {
    try {
      const market = await discoverPumpMarket(connection, mintPublicKey);
      pumpQuoteIncomplete ||= market.incomplete;
      if (market.available) {
        try {
          const liveQuote = await pumpQuote(connection, {
            mintAddress,
            side: 'sell',
            amountIn,
            slippageBps: 0,
          }, market.curveAddress.toBase58());
          const outputRaw = decimalToRaw(liveQuote.amountOut, liveQuote.quoteDecimals);
          if (liveQuote.side !== 'sell'
            || liveQuote.inputMint !== mintAddress
            || liveQuote.outputMint !== SOL_MINT.toBase58()
            || liveQuote.quoteMint !== SOL_MINT.toBase58()
            || liveQuote.quoteDecimals !== 9
            || liveQuote.amountIn !== amountIn
            || outputRaw === null
            || (liveQuote.venue !== 'PUMP_FUN' && liveQuote.venue !== 'PUMP_SWAP')) {
            pumpQuoteIncomplete = true;
          } else {
            quotes.push({
              quoteMint: liveQuote.quoteMint,
              quoteSymbol: 'SOL',
              amountOut: liveQuote.amountOut,
              amountOutRaw: outputRaw.toString(),
              quoteDecimals: liveQuote.quoteDecimals,
              minimumAmountOut: liveQuote.minimumAmountOut,
              estimatedPoolFee: liveQuote.estimatedPoolFee,
              priceImpactPercent: liveQuote.priceImpactPercent,
              poolAddress: liveQuote.poolAddress,
              venue: liveQuote.venue,
            });
          }
        } catch {
          pumpQuoteIncomplete = true;
        }
      }
    } catch {
      pumpQuoteIncomplete = true;
    }
  }

  return {
    success: true as const,
    network: 'Solana Devnet' as const,
    mintAddress,
    amountIn,
    amountRaw: amountRaw.toString(),
    tokenDecimals: decimals,
    quoteSource: 'Raydium CPMM and canonical Pump.fun/PumpSwap quotes calculated from current Devnet RPC state',
    quotedAt: new Date().toISOString(),
    quotes,
    searchedQuoteAssets: (Object.keys(QUOTE_ASSETS) as QuoteAsset[]).map((asset) => ({
      quoteMint: QUOTE_ASSETS[asset].mintAddress,
      quoteSymbol: asset,
      hasIndexedCandidate: discovery.find((entry) => entry.quoteAsset === asset)!.candidates.length > 0,
    })),
    coverageIncomplete: discoveryIncomplete || quoteAttemptsIncomplete || pumpQuoteIncomplete,
  };
}
