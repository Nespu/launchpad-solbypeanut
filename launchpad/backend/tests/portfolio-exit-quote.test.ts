import assert from 'node:assert/strict';
import test from 'node:test';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, bondingCurvePda } from '@pump-fun/pump-sdk';
import { PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk';
import { parseRaydiumDevnetCpmmCandidates, quotePortfolioExit } from '../src/services/portfolioExitQuoteService';
import { DEVNET_USDC_MINT_ADDRESS, SOL_MINT_ADDRESS } from '../src/services/poolQuoteAsset';

const tokenMint = '11111111111111111111111111111111';
const quoteMint = 'So11111111111111111111111111111111111111112';
const firstPool = 'Vote111111111111111111111111111111111111111';
const secondPool = 'Stake11111111111111111111111111111111111111';
const otherMint = 'SysvarRent111111111111111111111111111111111';

function pool(id: string, tvl: number, pooltype: string[], mintA = tokenMint, mintB = quoteMint) {
  return { id, tvl, pooltype, mintA: { address: mintA }, mintB: { address: mintB } };
}

test('discovers only matching CPMM pair candidates and ranks them by indexed TVL', () => {
  const result = parseRaydiumDevnetCpmmCandidates({
    success: true,
    data: {
      data: [
        pool(firstPool, 5, ['Cpmm']),
        pool(secondPool, 20, ['Cpmm'], quoteMint, tokenMint),
        pool('BPFLoaderUpgradeab1e11111111111111111111111', 100, ['Clmm']),
        pool('Config1111111111111111111111111111111111111', 500, ['Cpmm'], tokenMint, otherMint),
      ],
    },
  }, tokenMint, quoteMint, 100);

  assert.deepEqual(result.candidates, [
    { id: secondPool, tvl: 20 },
    { id: firstPool, tvl: 5 },
  ]);
  assert.equal(result.incomplete, false);
});

test('marks a full index page as incomplete and rejects an invalid response shape', () => {
  const fullPage = Array.from({ length: 2 }, (_, index) => pool(index === 0 ? firstPool : secondPool, 1, ['Cpmm']));
  const result = parseRaydiumDevnetCpmmCandidates({ success: true, data: { data: fullPage } }, tokenMint, quoteMint, 2);
  assert.equal(result.incomplete, true);
  assert.throws(() => parseRaydiumDevnetCpmmCandidates({ success: false, data: { data: [] } }, tokenMint, quoteMint));
  assert.throws(() => parseRaydiumDevnetCpmmCandidates({ success: true, data: {} }, tokenMint, quoteMint));
});

test('quotes the exact raw balance against each available quote asset and selects the best live CPMM result', async () => {
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, mintData);
  const connection = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: async () => ({ data: mintData, owner: TOKEN_PROGRAM_ID }),
  } as unknown as Connection;
  const calls: { poolAddress: string; amountIn: string; slippageBps: number }[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const quote = url.searchParams.get('mint2');
    const rows = quote === SOL_MINT_ADDRESS
      ? [pool(firstPool, 5, ['Cpmm']), pool(secondPool, 20, ['Cpmm'])]
      : [pool('BPFLoaderUpgradeab1e11111111111111111111111', 8, ['Cpmm'], tokenMint, DEVNET_USDC_MINT_ADDRESS)];
    return new Response(JSON.stringify({ success: true, data: { data: rows } }), { status: 200 });
  };
  const quote = async (_connection: Connection, poolAddress: string, request: { mintAddress: string; amountIn: string; slippageBps: number }) => {
    calls.push({ poolAddress, amountIn: request.amountIn, slippageBps: request.slippageBps });
    const quoteMint = poolAddress === 'BPFLoaderUpgradeab1e11111111111111111111111' ? DEVNET_USDC_MINT_ADDRESS : SOL_MINT_ADDRESS;
    const quoteDecimals = quoteMint === SOL_MINT_ADDRESS ? 9 : 6;
    return {
      outputMint: quoteMint,
      quoteMint,
      quoteDecimals,
      amountOut: poolAddress === firstPool ? '0.4' : poolAddress === secondPool ? '0.5' : '2',
      minimumAmountOut: '0',
      estimatedPoolFee: '0.001',
      priceImpactPercent: '1.0000',
    } as Awaited<ReturnType<typeof import('../src/services/swapService').quoteRaydiumSwap>>;
  };

  const result = await quotePortfolioExit(connection, tokenMint, '1234567', { fetcher, quote });

  assert.equal(result.amountIn, '1.234567');
  assert.equal(result.quotes.length, 2);
  assert.deepEqual(result.quotes.map(({ quoteSymbol, amountOut, amountOutRaw }) => ({ quoteSymbol, amountOut, amountOutRaw })), [
    { quoteSymbol: 'SOL', amountOut: '0.5', amountOutRaw: '500000000' },
    { quoteSymbol: 'USDC', amountOut: '2', amountOutRaw: '2000000' },
  ]);
  assert.equal(calls.length, 3);
  assert(calls.every((call) => call.amountIn === '1.234567' && call.slippageBps === 0));
});

test('quotes the exact raw balance against a canonical Pump.fun Devnet curve', async () => {
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, mintData);
  const mint = new PublicKey(tokenMint);
  const curveAddress = bondingCurvePda(mint);
  const poolAddress = canonicalPumpPoolPda(mint, new PublicKey(SOL_MINT_ADDRESS));
  const connection = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) return { data: mintData, owner: TOKEN_2022_PROGRAM_ID };
      if (address.equals(curveAddress)) return { data: Buffer.alloc(1), owner: PUMP_PROGRAM_ID };
      if (address.equals(poolAddress)) return null;
      return null;
    },
  } as unknown as Connection;
  let received: { amountIn: string; slippageBps: number; expectedCurveAddress: string | null } | null = null;
  const pumpQuote = async (_connection: Connection, request: { amountIn: string; slippageBps: number }, expectedCurveAddress: string | null) => {
    received = { amountIn: request.amountIn, slippageBps: request.slippageBps, expectedCurveAddress };
    return {
      venue: 'PUMP_FUN',
      poolAddress: curveAddress.toBase58(),
      side: 'sell',
      inputMint: tokenMint,
      outputMint: SOL_MINT_ADDRESS,
      quoteMint: SOL_MINT_ADDRESS,
      quoteDecimals: 9,
      amountIn: '1.234567',
      amountOut: '0.0042',
      minimumAmountOut: '0.0042',
      estimatedPoolFee: '0.0001',
      priceImpactPercent: '2.5000',
      slippageBps: 0,
      network: 'Solana Devnet',
    } as Awaited<ReturnType<typeof import('../src/services/pumpAmmSwapService').quotePumpSwap>>;
  };

  const result = await quotePortfolioExit(connection, tokenMint, '1234567', {
    fetcher: async () => new Response(JSON.stringify({ success: true, data: { data: [] } }), { status: 200 }),
    pumpQuote,
  });

  assert.deepEqual(received, { amountIn: '1.234567', slippageBps: 0, expectedCurveAddress: curveAddress.toBase58() });
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].venue, 'PUMP_FUN');
  assert.equal(result.quotes[0].amountOutRaw, '4200000');
  assert.equal(result.coverageIncomplete, false);
});

test('quotes a canonical PumpSwap pool after curve migration', async () => {
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, mintData);
  const mint = new PublicKey(tokenMint);
  const curveAddress = bondingCurvePda(mint);
  const poolAddress = canonicalPumpPoolPda(mint, new PublicKey(SOL_MINT_ADDRESS));
  const connection = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) return { data: mintData, owner: TOKEN_2022_PROGRAM_ID };
      if (address.equals(poolAddress)) return { data: Buffer.alloc(1), owner: PUMP_AMM_PROGRAM_ID };
      return null;
    },
  } as unknown as Connection;
  const pumpQuote = async () => ({
    venue: 'PUMP_SWAP',
    poolAddress: poolAddress.toBase58(),
    side: 'sell',
    inputMint: tokenMint,
    outputMint: SOL_MINT_ADDRESS,
    quoteMint: SOL_MINT_ADDRESS,
    quoteDecimals: 9,
    amountIn: '1.234567',
    amountOut: '0.0051',
    minimumAmountOut: '0.0051',
    estimatedPoolFee: '0.0001',
    priceImpactPercent: null,
    slippageBps: 0,
    network: 'Solana Devnet',
  } as Awaited<ReturnType<typeof import('../src/services/pumpAmmSwapService').quotePumpSwap>>);

  const result = await quotePortfolioExit(connection, tokenMint, '1234567', {
    fetcher: async () => new Response(JSON.stringify({ success: true, data: { data: [] } }), { status: 200 }),
    pumpQuote,
  });

  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].venue, 'PUMP_SWAP');
  assert.equal(result.quotes[0].poolAddress, poolAddress.toBase58());
  assert.equal(result.quotes[0].priceImpactPercent, null);
  assert.equal(result.coverageIncomplete, false);
});
