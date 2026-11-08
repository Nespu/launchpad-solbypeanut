import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import type { CpmmComputeData, RaydiumLoadParams } from '@raydium-io/raydium-sdk-v2';
import { QUOTE_ASSETS } from './poolQuoteAsset';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const MAX_SWAP_INPUT_RAW = 10n ** 30n;

export type SwapSide = 'buy' | 'sell';

export interface SwapRequest {
  mintAddress: string;
  side: SwapSide;
  amountIn: string;
  slippageBps: number;
}

interface SwapContext {
  poolAddress: string;
  side: SwapSide;
  inputMint: string;
  outputMint: string;
  inputDecimals: number;
  outputDecimals: number;
  inputSymbol: string;
  outputSymbol: string;
  quoteMint: string;
  quoteDecimals: number;
  inputAmountRaw: bigint;
  inputReserveRaw: bigint;
  slippage: number;
  raydium: any;
  poolInfo: any;
  poolKeys: any;
  pool: any;
  quote: any;
}

function toRawAmount(value: string, decimals: number): bigint {
  const match = /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(value);
  if (!match) throw new Error('Enter a valid positive amount.');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error('Amount has too many decimal places for this token.');
  const raw = BigInt(match[1]) * (10n ** BigInt(decimals))
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n || raw > MAX_SWAP_INPUT_RAW) throw new Error('Amount is outside the supported range.');
  return raw;
}

function fromRawAmount(raw: bigint | string, decimals: number): string {
  const value = BigInt(raw);
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function buildSwapContext(
  connection: Connection,
  poolAddress: string,
  request: SwapRequest,
  owner?: PublicKey,
): Promise<SwapContext> {
  if (request.side !== 'buy' && request.side !== 'sell') throw new Error('Choose buy or sell for this swap.');
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 500) {
    throw new Error('Swap slippage must be between 0% and 5%.');
  }
  const mint = new PublicKey(request.mintAddress);
  const poolPublicKey = new PublicKey(poolAddress);
  const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
  const loadParams: RaydiumLoadParams = {
    connection,
    cluster: 'devnet',
    disableLoadToken: true,
    ...(owner ? { owner } : {}),
  };
  const raydium = await Raydium.load(loadParams);
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolPublicKey.toBase58());
  const configInfo = rpcData.configInfo;
  if (!configInfo) throw new Error('Raydium pool fee configuration could not be loaded.');

  const mintA = String(poolInfo.mintA?.address ?? '');
  const mintB = String(poolInfo.mintB?.address ?? '');
  const quoteAsset = Object.values(QUOTE_ASSETS).find((asset) =>
    (asset.mintAddress === mintA && mintB === mint.toBase58())
      || (asset.mintAddress === mintB && mintA === mint.toBase58()),
  );
  if (!quoteAsset) throw new Error('This pool is not a supported Devnet SOL or USDC pair for this token.');
  const quoteMint = quoteAsset.mintAddress;

  const inputMint = request.side === 'buy' ? quoteMint : mint.toBase58();
  const outputMint = request.side === 'buy' ? mint.toBase58() : quoteMint;
  const inputToken = inputMint === mintA ? poolInfo.mintA : poolInfo.mintB;
  const outputToken = outputMint === mintA ? poolInfo.mintA : poolInfo.mintB;
  const inputDecimals = inputMint === quoteMint ? quoteAsset.decimals : Number(inputToken.decimals);
  const outputDecimals = outputMint === quoteMint ? quoteAsset.decimals : Number(outputToken.decimals);
  if (!Number.isInteger(inputDecimals) || inputDecimals < 0 || inputDecimals > 18
    || !Number.isInteger(outputDecimals) || outputDecimals < 0 || outputDecimals > 18) {
    throw new Error('Pool token decimals are not supported.');
  }

  const inputAmountRaw = toRawAmount(request.amountIn, inputDecimals);
  const inputReserveValue = inputMint === mintA ? rpcData.baseReserve : rpcData.quoteReserve;
  const inputReserveRaw = BigInt(inputReserveValue?.toString?.() ?? inputReserveValue ?? '0');
  if (inputReserveRaw <= 0n) throw new Error('Pool input reserve could not be loaded.');
  const slippage = request.slippageBps / 10_000;
  const pool: CpmmComputeData = {
    ...rpcData,
    id: poolPublicKey,
    version: 7,
    configInfo,
    mintA: poolInfo.mintA,
    mintB: poolInfo.mintB,
    authority: new PublicKey(poolKeys.authority),
  };
  const quote = raydium.cpmm.computeSwapAmount({
    pool,
    amountIn: new BN(inputAmountRaw.toString()),
    outputMint,
    slippage,
  });

  if (BigInt(quote.amountOut.toString()) <= 0n) {
    throw new Error('This amount cannot be quoted with the current pool liquidity.');
  }

  return {
    poolAddress: poolPublicKey.toBase58(),
    side: request.side,
    inputMint,
    outputMint,
    inputDecimals,
    outputDecimals,
    inputSymbol: inputMint === SOL_MINT.toBase58() ? 'SOL' : String(inputToken.symbol || 'TOKEN'),
    outputSymbol: outputMint === SOL_MINT.toBase58() ? 'SOL' : String(outputToken.symbol || 'TOKEN'),
    quoteMint,
    quoteDecimals: quoteAsset.decimals,
    inputAmountRaw,
    inputReserveRaw,
    slippage,
    raydium,
    poolInfo,
    poolKeys,
    pool,
    quote,
  };
}

function calculateCurveImpactPercent(inputAmountRaw: bigint, inputReserveRaw: bigint): string {
  // CPMM curve impact versus the spot price, excluding the pool fee shown separately.
  // Scale by 1e6 to express a percentage with four decimal places.
  const denominator = inputReserveRaw + inputAmountRaw;
  const scaled = (inputAmountRaw * 1_000_000n + denominator / 2n) / denominator;
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0');
  return `${whole}.${fraction}`;
}

function serializeQuote(context: SwapContext) {
  const quote = context.quote;
  return {
    venue: 'RAYDIUM',
    poolAddress: context.poolAddress,
    side: context.side,
    inputMint: context.inputMint,
    outputMint: context.outputMint,
    inputSymbol: context.inputMint === context.quoteMint
      ? Object.values(QUOTE_ASSETS).find((asset) => asset.mintAddress === context.quoteMint)!.symbol
      : context.inputSymbol,
    outputSymbol: context.outputMint === context.quoteMint
      ? Object.values(QUOTE_ASSETS).find((asset) => asset.mintAddress === context.quoteMint)!.symbol
      : context.outputSymbol,
    quoteMint: context.quoteMint,
    quoteDecimals: context.quoteDecimals,
    amountIn: fromRawAmount(context.inputAmountRaw, context.inputDecimals),
    amountOut: fromRawAmount(quote.amountOut.toString(), context.outputDecimals),
    minimumAmountOut: fromRawAmount(quote.minAmountOut.toString(), context.outputDecimals),
    maximumAmountIn: context.side === 'buy' ? fromRawAmount(context.inputAmountRaw, context.inputDecimals) : null,
    estimatedPoolFee: fromRawAmount(quote.fee.toString(), context.inputDecimals),
    priceImpactPercent: calculateCurveImpactPercent(context.inputAmountRaw, context.inputReserveRaw),
    slippageBps: Math.round(context.slippage * 10_000),
    network: 'Solana Devnet',
  };
}

export async function quoteRaydiumSwap(
  connection: Connection,
  poolAddress: string,
  request: SwapRequest,
) {
  const context = await buildSwapContext(connection, poolAddress, request);
  return serializeQuote(context);
}

export async function prepareRaydiumSwap(
  connection: Connection,
  poolAddress: string,
  userWallet: PublicKey,
  request: SwapRequest,
) {
  const context = await buildSwapContext(connection, poolAddress, request, userWallet);
  const baseIn = context.inputMint === String(context.poolInfo.mintA.address);
  const { transaction } = await context.raydium.cpmm.swap({
    poolInfo: context.poolInfo,
    poolKeys: context.poolKeys,
    payer: userWallet,
    baseIn,
    inputAmount: new BN(context.inputAmountRaw.toString()),
    swapResult: {
      sourceAmountSwapped: context.quote.amountIn,
      destinationAmountSwapped: context.quote.amountOut,
    },
    slippage: context.slippage,
    config: { associatedOnly: true, checkCreateATAOwner: true },
    txVersion: (await import('@raydium-io/raydium-sdk-v2')).TxVersion.LEGACY,
  });

  const tx = transaction as Transaction;
  tx.feePayer = userWallet;
  tx.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    ...tx.instructions.filter((instruction) => !instruction.programId.equals(ComputeBudgetProgram.programId)),
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const transactionMessageHash = createHash('sha256')
    .update(tx.compileMessage().serialize())
    .digest('hex');
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  return {
    transaction: serialized.toString('base64'),
    transactionMessageHash,
    lastValidBlockHeight,
    quote: serializeQuote(context),
  };
}
