import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  buyQuoteInput as calculateBuyQuote,
  canonicalPumpPoolPda,
  isPumpPool,
  sellBaseInput as calculateSellBase,
} from '@pump-fun/pump-swap-sdk';
import {
  bondingCurvePda,
  isBondingCurveMigrated,
  OnlinePumpSdk,
} from '@pump-fun/pump-sdk';
import { PublicError } from '../utils/publicError';
import type { SwapRequest } from './swapService';

const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const MAX_SWAP_INPUT_RAW = 10n ** 30n;
const PUMP_AMM_COMPUTE_UNITS = 350_000;

export type PumpVenue = 'PUMP_FUN' | 'PUMP_SWAP';

export type ResolvedPumpVenue = {
  venue: PumpVenue;
  marketAddress: string;
};

function parseAmount(value: string, decimals: number): BN {
  const match = /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) throw new PublicError('Escribe un importe positivo válido.', 400);
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new PublicError('El importe supera la precisión permitida para este activo.', 400);
  const raw = BigInt(match[1]) * (10n ** BigInt(decimals))
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n || raw > MAX_SWAP_INPUT_RAW) throw new PublicError('El importe está fuera del rango permitido.', 400);
  return new BN(raw.toString());
}

function formatAmount(raw: BN | bigint | string, decimals: number): string {
  const value = BigInt(raw.toString());
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function percentImpact(input: BN, output: BN, reserveIn: BN, reserveOut: BN): string | null {
  if (input.isZero() || output.isZero() || reserveIn.isZero() || reserveOut.lte(output)) return null;
  const scale = new BN('1000000000000');
  const spot = reserveIn.mul(scale).div(reserveOut);
  const effective = input.mul(scale).div(output);
  if (spot.isZero()) return null;
  const percentBps = effective.sub(spot).muln(10_000).div(spot);
  return (percentBps.toNumber() / 100).toFixed(4);
}

export async function resolvePumpVenue(
  connection: Connection,
  mintAddress: string,
  expectedCurveAddress: string | null,
): Promise<ResolvedPumpVenue> {
  const mint = new PublicKey(mintAddress);
  const curveAddress = bondingCurvePda(mint);
  if (!expectedCurveAddress || new PublicKey(expectedCurveAddress).toBase58() !== curveAddress.toBase58()) {
    throw new PublicError('La dirección de la curva no coincide con el registro de este token.', 409);
  }

  const poolAddress = canonicalPumpPoolPda(mint, NATIVE_MINT);
  const poolAccount = await connection.getAccountInfo(poolAddress, 'confirmed');
  if (poolAccount) {
    if (!poolAccount.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      throw new PublicError('La dirección de PumpSwap existe, pero no pertenece al programa oficial.', 409);
    }
    const pool = PUMP_AMM_SDK.decodePoolNullable(poolAccount);
    if (!pool || !isPumpPool(pool.baseMint, pool.creator) || !pool.baseMint.equals(mint) || !pool.quoteMint.equals(NATIVE_MINT)) {
      throw new PublicError('La pool PumpSwap no coincide con el token y el par SOL esperados.', 409);
    }
    return { venue: 'PUMP_SWAP', marketAddress: poolAddress.toBase58() };
  }

  const curve = await new OnlinePumpSdk(connection).fetchBondingCurve(mint);
  if (curve.complete || isBondingCurveMigrated(curve)) {
    throw new PublicError('La curva ya se graduó y su pool PumpSwap todavía no aparece en Solana.', 409);
  }
  return { venue: 'PUMP_FUN', marketAddress: curveAddress.toBase58() };
}

async function getAmmState(connection: Connection, mintAddress: string, userWallet: PublicKey) {
  const mint = new PublicKey(mintAddress);
  const poolAddress = canonicalPumpPoolPda(mint, NATIVE_MINT);
  const sdk = new OnlinePumpAmmSdk(connection);
  const state = await sdk.swapSolanaState(poolAddress, userWallet);
  if (!state.poolKey.equals(poolAddress)
    || !state.pool.baseMint.equals(mint)
    || !state.pool.quoteMint.equals(NATIVE_MINT)
    || !isPumpPool(state.pool.baseMint, state.pool.creator)) {
    throw new PublicError('La pool PumpSwap cargada no coincide con este token y el par SOL.', 409);
  }
  return { mint, poolAddress, sdk, state };
}

export function pumpAmmBuyLimits(quote: { base: BN; maxQuote: BN }) {
  // PumpSwap's buy instruction requests exact base output and caps quote input.
  return { minimumAmountOut: quote.base, maximumAmountIn: quote.maxQuote };
}

function getAmmAmounts(
  state: Awaited<ReturnType<typeof getAmmState>>['state'],
  request: SwapRequest,
) {
  if (request.side !== 'buy' && request.side !== 'sell') throw new PublicError('Elige compra o venta para este intercambio.', 400);
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 500) {
    throw new PublicError('El slippage debe estar entre 0% y 5%.', 400);
  }

  const tokenDecimals = state.baseMintAccount.decimals;
  if (tokenDecimals !== 6) throw new PublicError('El token Pump.fun no usa la precisión esperada de 6 decimales.', 409);
  const amountIn = parseAmount(request.amountIn, request.side === 'buy' ? 9 : tokenDecimals);
  const slippage = request.slippageBps / 100;
  const pool = state.pool;
  const common = {
    baseReserve: state.poolBaseAmount,
    quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: pool.virtualQuoteReserves,
    feeBucketsTotal: pool.protocolFees.add(pool.creatorFees),
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint,
    coinCreator: pool.coinCreator,
    creator: pool.creator,
    feeConfig: state.feeConfig,
    quoteMint: pool.quoteMint,
    isMayhemMode: pool.isMayhemMode,
    creatorFeeBps: pool.creatorFeeBps,
  };

  if (request.side === 'buy') {
    const quote = calculateBuyQuote({ ...common, quote: amountIn, slippage });
    if (quote.base.isZero()) throw new PublicError('La pool no tiene tokens disponibles para esta compra.', 409);
    const { minimumAmountOut, maximumAmountIn } = pumpAmmBuyLimits(quote);
    const estimatedFee = amountIn.sub(quote.internalQuoteWithoutFees);
    const effectiveQuoteReserve = state.poolQuoteAmount.add(pool.virtualQuoteReserves);
    return {
      amountIn,
      amountOut: quote.base,
      minimumAmountOut,
      maximumAmountIn,
      fee: estimatedFee.isNeg() ? new BN(0) : estimatedFee,
      impact: percentImpact(amountIn, quote.base, effectiveQuoteReserve, state.poolBaseAmount),
      tokenDecimals,
    };
  }

  const quote = calculateSellBase({ ...common, base: amountIn, slippage });
  if (quote.uiQuote.isZero()) throw new PublicError('La cotización de venta es cero; reduce el importe e inténtalo de nuevo.', 409);
  const estimatedFee = quote.internalQuoteAmountOut.sub(quote.uiQuote);
  const realQuoteReserve = state.poolQuoteAmount.sub(pool.protocolFees).sub(pool.creatorFees);
  return {
    amountIn,
    amountOut: quote.uiQuote,
    minimumAmountOut: quote.minQuote,
    maximumAmountIn: null,
    fee: estimatedFee.isNeg() ? new BN(0) : estimatedFee,
    impact: percentImpact(amountIn, quote.uiQuote, state.poolBaseAmount, realQuoteReserve.add(pool.virtualQuoteReserves)),
    tokenDecimals,
  };
}

function serializeQuote(
  marketAddress: string,
  state: Awaited<ReturnType<typeof getAmmState>>['state'],
  request: SwapRequest,
) {
  const amounts = getAmmAmounts(state, request);
  const inputDecimals = request.side === 'buy' ? 9 : amounts.tokenDecimals;
  const outputDecimals = request.side === 'buy' ? amounts.tokenDecimals : 9;
  return {
    venue: 'PUMP_SWAP',
    poolAddress: marketAddress,
    side: request.side,
    inputMint: request.side === 'buy' ? NATIVE_MINT.toBase58() : state.baseMint.toBase58(),
    outputMint: request.side === 'buy' ? state.baseMint.toBase58() : NATIVE_MINT.toBase58(),
    inputSymbol: request.side === 'buy' ? 'SOL' : 'TOKEN',
    outputSymbol: request.side === 'buy' ? 'TOKEN' : 'SOL',
    quoteMint: NATIVE_MINT.toBase58(),
    quoteDecimals: 9,
    amountIn: formatAmount(amounts.amountIn, inputDecimals),
    amountOut: formatAmount(amounts.amountOut, outputDecimals),
    minimumAmountOut: formatAmount(amounts.minimumAmountOut, outputDecimals),
    maximumAmountIn: amounts.maximumAmountIn === null ? null : formatAmount(amounts.maximumAmountIn, inputDecimals),
    estimatedPoolFee: formatAmount(amounts.fee, 9),
    priceImpactPercent: amounts.impact,
    slippageBps: request.slippageBps,
    network: 'Solana Devnet',
  };
}

export async function quotePumpAmmSwap(connection: Connection, request: SwapRequest, poolAddress: string) {
  const { state } = await getAmmState(connection, request.mintAddress, PublicKey.default);
  if (state.poolKey.toBase58() !== poolAddress) throw new PublicError('La dirección de PumpSwap cambió al cotizar.', 409);
  return serializeQuote(poolAddress, state, request);
}

export async function preparePumpAmmSwap(
  connection: Connection,
  userWallet: PublicKey,
  request: SwapRequest,
  poolAddress: string,
) {
  const { state } = await getAmmState(connection, request.mintAddress, userWallet);
  if (state.poolKey.toBase58() !== poolAddress) throw new PublicError('La dirección de PumpSwap cambió al preparar la firma.', 409);
  const amounts = getAmmAmounts(state, request);
  const slippage = request.slippageBps / 100;
  const instructions = request.side === 'buy'
    ? await PUMP_AMM_SDK.buyQuoteInput(state, amounts.amountIn, slippage, { v2: true })
    : await PUMP_AMM_SDK.sellBaseInput(state, amounts.amountIn, slippage, { v2: true });
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: PUMP_AMM_COMPUTE_UNITS }),
    ...instructions,
  );
  transaction.feePayer = userWallet;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  const transactionMessageHash = createHash('sha256').update(transaction.serializeMessage()).digest('hex');

  return {
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    transactionMessageHash,
    lastValidBlockHeight,
    quote: serializeQuote(poolAddress, state, request),
  };
}

export async function quotePumpSwap(
  connection: Connection,
  request: SwapRequest,
  expectedCurveAddress: string | null,
) {
  const market = await resolvePumpVenue(connection, request.mintAddress, expectedCurveAddress);
  if (market.venue === 'PUMP_SWAP') return quotePumpAmmSwap(connection, request, market.marketAddress);
  const { quotePumpCurveSwap } = await import('./pumpSwapService');
  return quotePumpCurveSwap(connection, request);
}

export async function preparePumpSwap(
  connection: Connection,
  userWallet: PublicKey,
  request: SwapRequest,
  expectedCurveAddress: string | null,
) {
  const market = await resolvePumpVenue(connection, request.mintAddress, expectedCurveAddress);
  if (market.venue === 'PUMP_SWAP') return preparePumpAmmSwap(connection, userWallet, request, market.marketAddress);
  const { preparePumpCurveSwap } = await import('./pumpSwapService');
  return preparePumpCurveSwap(connection, userWallet, request);
}
