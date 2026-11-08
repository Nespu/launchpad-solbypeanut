import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMint,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  bondingCurvePda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getFee,
  getSellSolAmountFromTokenAmount,
  isBondingCurveMigrated,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  pumpIdl,
} from '@pump-fun/pump-sdk';
import { PublicError } from '../utils/publicError';
import type { SwapRequest } from './swapService';

const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const MAX_SWAP_INPUT_RAW = 10n ** 30n;
const PUMP_SWAP_COMPUTE_UNITS = 250_000;
const PUMP_TRADE_DISCRIMINATOR = Buffer.from(
  (pumpIdl as unknown as { events: Array<{ name: string; discriminator: number[] }> })
    .events.find((event) => event.name === 'TradeEvent')?.discriminator ?? [],
);

if (PUMP_TRADE_DISCRIMINATOR.length !== 8) {
  throw new Error('The installed Pump SDK does not expose the expected TradeEvent discriminator');
}

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
  const spot = reserveIn.mul(new BN('1000000000000')).div(reserveOut);
  const effective = input.mul(new BN('1000000000000')).div(output);
  if (spot.isZero()) return null;
  const percentBps = effective.sub(spot).muln(10_000).div(spot);
  return (percentBps.toNumber() / 100).toFixed(4);
}

async function getCurveContext(connection: Connection, mintAddress: string) {
  const mint = new PublicKey(mintAddress);
  const onlineSdk = new OnlinePumpSdk(connection);
  const [global, feeConfig, bondingCurve, mintInfo] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
    onlineSdk.fetchBondingCurve(mint),
    getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
  ]);

  if (!bondingCurve.quoteMint.equals(PublicKey.default)) {
    throw new PublicError('Wire solo admite curvas Pump.fun cotizadas en SOL por ahora.', 409);
  }
  if (bondingCurve.complete || isBondingCurveMigrated(bondingCurve)) {
    throw new PublicError('La curva ya se graduó. El intercambio posterior ocurre en PumpSwap; Wire todavía no puede operar esa pool.', 409);
  }

  return {
    mint,
    curveAddress: bondingCurvePda(mint),
    global,
    feeConfig,
    bondingCurve,
    mintSupply: new BN(mintInfo.supply.toString()),
    tokenDecimals: mintInfo.decimals,
    onlineSdk,
  };
}

export function applyQuoteInputSlippage(quoteAmount: BN, slippageBps: number): BN {
  // Matches Pump's buy_v2 cap: floor(quoteAmount * floor(slippageBps / 10) / 1000).
  const slippageTenthsPercent = Math.floor(slippageBps / 10);
  return quoteAmount.add(quoteAmount.muln(slippageTenthsPercent).divn(1000));
}

function getAmounts(context: Awaited<ReturnType<typeof getCurveContext>>, request: SwapRequest) {
  if (request.side !== 'buy' && request.side !== 'sell') throw new PublicError('Elige compra o venta para este intercambio.', 400);
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 500) {
    throw new PublicError('El slippage debe estar entre 0% y 5%.', 400);
  }

  const amountIn = parseAmount(request.amountIn, request.side === 'buy' ? 9 : 6);
  const curve = context.bondingCurve;
  const tokenDecimals = context.tokenDecimals;
  if (tokenDecimals !== 6) throw new PublicError('La curva Pump.fun de este token no usa la precisión esperada de 6 decimales.', 409);
  let amountOut: BN;
  let quoteAmount: BN;
  let fee: BN;
  let impact: string | null;

  if (request.side === 'buy') {
    amountOut = getBuyTokenAmountFromSolAmount({
      global: context.global,
      feeConfig: context.feeConfig,
      mintSupply: context.mintSupply,
      bondingCurve: curve,
      amount: amountIn,
      quoteMint: NATIVE_MINT,
    });
    if (amountOut.isZero()) throw new PublicError('La curva no tiene tokens disponibles para esta compra.', 409);
    quoteAmount = getBuySolAmountFromTokenAmount({
      global: context.global,
      feeConfig: context.feeConfig,
      mintSupply: context.mintSupply,
      bondingCurve: curve,
      amount: amountOut,
      quoteMint: NATIVE_MINT,
    });
    fee = getFee({
      global: context.global,
      feeConfig: context.feeConfig,
      mintSupply: context.mintSupply,
      bondingCurve: curve,
      amount: quoteAmount,
      isNewBondingCurve: false,
    });
    impact = percentImpact(quoteAmount, amountOut, curve.virtualQuoteReserves, curve.virtualTokenReserves);
  } else {
    amountOut = getSellSolAmountFromTokenAmount({
      global: context.global,
      feeConfig: context.feeConfig,
      mintSupply: context.mintSupply,
      bondingCurve: curve,
      amount: amountIn,
    });
    if (amountOut.isZero()) throw new PublicError('La cotización de venta es cero; reduce el importe e inténtalo de nuevo.', 409);
    const grossQuote = curve.virtualQuoteReserves.mul(amountIn)
      .div(curve.virtualTokenReserves.add(amountIn));
    fee = grossQuote.sub(amountOut);
    quoteAmount = amountOut;
    impact = percentImpact(amountIn, amountOut, curve.virtualTokenReserves, curve.virtualQuoteReserves);
  }

  const slippageMultiplier = BigInt(10_000 - request.slippageBps);
  const minimumAmountOut = request.side === 'buy'
    ? amountOut
    : new BN((BigInt(amountOut.toString()) * slippageMultiplier / 10_000n).toString());

  const maximumAmountIn = request.side === 'buy'
    ? applyQuoteInputSlippage(quoteAmount, request.slippageBps)
    : null;

  return { amountIn, amountOut, quoteAmount, fee, impact, minimumAmountOut, maximumAmountIn, tokenDecimals };
}

function serializeQuote(context: Awaited<ReturnType<typeof getCurveContext>>, request: SwapRequest) {
  const amounts = getAmounts(context, request);
  return {
    venue: 'PUMP_FUN',
    poolAddress: context.curveAddress.toBase58(),
    side: request.side,
    inputMint: request.side === 'buy' ? NATIVE_MINT.toBase58() : context.mint.toBase58(),
    outputMint: request.side === 'buy' ? context.mint.toBase58() : NATIVE_MINT.toBase58(),
    inputSymbol: request.side === 'buy' ? 'SOL' : 'TOKEN',
    outputSymbol: request.side === 'buy' ? 'TOKEN' : 'SOL',
    quoteMint: NATIVE_MINT.toBase58(),
    quoteDecimals: 9,
    amountIn: formatAmount(amounts.amountIn, request.side === 'buy' ? 9 : amounts.tokenDecimals),
    amountOut: formatAmount(amounts.amountOut, request.side === 'buy' ? amounts.tokenDecimals : 9),
    minimumAmountOut: formatAmount(amounts.minimumAmountOut, request.side === 'buy' ? amounts.tokenDecimals : 9),
    maximumAmountIn: amounts.maximumAmountIn === null ? null : formatAmount(amounts.maximumAmountIn, 9),
    estimatedPoolFee: formatAmount(amounts.fee, 9),
    priceImpactPercent: amounts.impact,
    slippageBps: request.slippageBps,
    network: 'Solana Devnet',
  };
}

export async function quotePumpCurveSwap(connection: Connection, request: SwapRequest) {
  const context = await getCurveContext(connection, request.mintAddress);
  return serializeQuote(context, request);
}

export async function preparePumpCurveSwap(
  connection: Connection,
  userWallet: PublicKey,
  request: SwapRequest,
) {
  const context = await getCurveContext(connection, request.mintAddress);
  const amounts = getAmounts(context, request);
  const slippage = request.slippageBps / 100;
  let instructions;
  if (request.side === 'buy') {
    const state = await context.onlineSdk.fetchBuyState(context.mint, userWallet, TOKEN_2022_PROGRAM_ID, NATIVE_MINT);
    instructions = await PUMP_SDK.buyV2Instructions({
      global: context.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint: context.mint,
      user: userWallet,
      amount: amounts.amountOut,
      quoteAmount: amounts.quoteAmount,
      slippage,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
  } else {
    const state = await context.onlineSdk.fetchSellState(context.mint, userWallet, TOKEN_2022_PROGRAM_ID, NATIVE_MINT);
    instructions = await PUMP_SDK.sellV2Instructions({
      global: context.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      mint: context.mint,
      user: userWallet,
      amount: amounts.amountIn,
      quoteAmount: amounts.quoteAmount,
      slippage,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
  }

  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: PUMP_SWAP_COMPUTE_UNITS }),
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
    quote: serializeQuote(context, request),
  };
}

export { PUMP_PROGRAM_ID, PUMP_TRADE_DISCRIMINATOR };
