import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  getTrackedRaydiumPoolAddressesInTransaction,
  matchTrackedRaydiumLpMovements,
  scanTrackedRaydiumLpPositions,
  type TrackedRaydiumPool,
} from './walletLpPositions';

const walletAddress = Keypair.generate().publicKey.toBase58();
const poolAddress = Keypair.generate().publicKey.toBase58();
const secondPoolAddress = Keypair.generate().publicKey.toBase58();
const tokenMint = Keypair.generate().publicKey.toBase58();
const secondTokenMint = Keypair.generate().publicKey.toBase58();
const lpMint = Keypair.generate().publicKey.toBase58();
const secondLpMint = Keypair.generate().publicKey.toBase58();
const quoteMint = Keypair.generate().publicKey.toBase58();
const poolProgramId = Keypair.generate().publicKey.toBase58();

function trackedPool(overrides: Partial<TrackedRaydiumPool> = {}): TrackedRaydiumPool {
  return {
    poolAddress,
    mintAddress: tokenMint,
    quoteMint,
    symbol: 'WIRE',
    launchPlatform: 'RAYDIUM',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('scans unique Raydium pools and returns positive LP positions only', async () => {
  const requestedPools: string[] = [];
  const result = await scanTrackedRaydiumLpPositions({
    walletAddress,
    apiBase: 'http://wire.test',
    pools: [
      trackedPool(),
      trackedPool({ symbol: 'duplicate record' }),
      trackedPool({ poolAddress: secondPoolAddress, mintAddress: secondTokenMint, symbol: 'SECOND' }),
      trackedPool({ launchPlatform: 'PUMP_FUN', poolAddress: Keypair.generate().publicKey.toBase58() }),
    ],
    fetcher: async (input) => {
      const url = new URL(String(input));
      requestedPools.push(url.searchParams.get('poolAddress') ?? '');
      const isSecond = url.searchParams.get('poolAddress') === secondPoolAddress;
      assert.equal(url.searchParams.get('includePosition'), 'true');
      return jsonResponse({
        success: true,
        lpMint: isSecond ? secondLpMint : lpMint,
        poolProgramId,
        rawBalance: isSecond ? '0' : '9007199254740993',
        decimals: 9,
        positionEstimateStatus: 'ready',
        positionEstimate: isSecond ? null : {
          lpMint,
          lpAmountRaw: '9007199254740993',
          lpSupplyRaw: '10000000000000000',
          poolKind: 'cpmm',
          assets: [
            { mintAddress: tokenMint, symbol: 'WIRE', decimals: 6, reserveRaw: '1000000000', amountRaw: '900719925' },
            { mintAddress: secondTokenMint, symbol: 'SOL', decimals: 9, reserveRaw: '800000000', amountRaw: '720575940' },
          ],
        },
      });
    },
  });

  assert.equal(result.poolsChecked, 2);
  assert.equal(result.poolsFailed, 0);
  assert.equal(requestedPools.length, 2);
  assert.deepEqual([...result.positionsByMint.keys()], [lpMint]);
  assert.deepEqual([...result.trackedPoolsByMint.keys()], [lpMint, secondLpMint]);
  assert.equal(result.trackedPoolsByMint.get(secondLpMint)?.poolAddress, secondPoolAddress);
  assert.deepEqual(result.positionsByMint.get(lpMint), {
    lpMint,
    rawBalance: '9007199254740993',
    decimals: 9,
    poolAddress,
    tokenMint,
    tokenSymbol: 'WIRE',
    positionEstimate: {
      lpMint,
      lpAmountRaw: '9007199254740993',
      lpSupplyRaw: '10000000000000000',
      poolKind: 'cpmm',
      assets: [
        { mintAddress: tokenMint, symbol: 'WIRE', decimals: 6, reserveRaw: '1000000000', amountRaw: '900719925' },
        { mintAddress: secondTokenMint, symbol: 'SOL', decimals: 9, reserveRaw: '800000000', amountRaw: '720575940' },
      ],
    },
    positionEstimateStatus: 'ready',
  });
});

test('counts invalid pool addresses and failed responses without inventing positions', async () => {
  const result = await scanTrackedRaydiumLpPositions({
    walletAddress,
    apiBase: 'http://wire.test',
    pools: [
      trackedPool(),
      trackedPool({ poolAddress: 'invalid-address' }),
      trackedPool({ poolAddress: secondPoolAddress }),
    ],
    fetcher: async (input) => new URL(String(input)).searchParams.get('poolAddress') === poolAddress
      ? jsonResponse({ success: true, lpMint, poolProgramId, rawBalance: '10', decimals: 6 })
      : jsonResponse({ success: false }, 500),
  });

  assert.equal(result.poolsChecked, 2);
  assert.equal(result.poolsFailed, 2);
  assert.deepEqual([...result.positionsByMint.keys()], [lpMint]);
});

test('omits ambiguous LP mints returned for multiple distinct pools', async () => {
  const result = await scanTrackedRaydiumLpPositions({
    walletAddress,
    apiBase: 'http://wire.test',
    pools: [
      trackedPool(),
      trackedPool({ poolAddress: secondPoolAddress, mintAddress: secondTokenMint, symbol: 'SECOND' }),
    ],
    fetcher: async () => jsonResponse({ success: true, lpMint, poolProgramId, rawBalance: '1', decimals: 9 }),
  });

  assert.equal(result.poolsChecked, 2);
  assert.equal(result.poolsFailed, 1);
  assert.equal(result.positionsByMint.size, 0);
  assert.equal(result.trackedPoolsByMint.size, 0);
});

test('matches LP balance changes only when the transaction names its registered pool', () => {
  const transaction = {
    transaction: { message: { accountKeys: [
      { pubkey: new Keypair().publicKey },
      { pubkey: { toBase58: () => poolAddress } },
    ], instructions: [{ programId: { toBase58: () => poolProgramId } }] } },
    meta: { innerInstructions: [] },
  };
  const tracked = {
    lpMint,
    poolAddress,
    poolProgramId,
    quoteMint,
    tokenMint,
    tokenSymbol: 'WIRE',
  };

  assert.deepEqual(getTrackedRaydiumPoolAddressesInTransaction(transaction, [trackedPool({ poolAddress })]), [poolAddress]);
  assert.deepEqual(matchTrackedRaydiumLpMovements({
    transaction,
    tokenDeltas: [{ mintAddress: lpMint, decimals: 9, amountRaw: '12' }, { mintAddress: tokenMint, decimals: 6, amountRaw: '-4' }],
    pools: [tracked],
  }), [tracked]);
  assert.deepEqual(matchTrackedRaydiumLpMovements({
    transaction: {
      ...transaction,
      transaction: {
        message: {
          ...transaction.transaction.message,
          instructions: [{ programId: { toBase58: () => Keypair.generate().publicKey.toBase58() } }],
        },
      },
    },
    tokenDeltas: [{ mintAddress: lpMint, decimals: 9, amountRaw: '12' }, { mintAddress: tokenMint, decimals: 6, amountRaw: '-4' }],
    pools: [tracked],
  }), []);
  assert.deepEqual(matchTrackedRaydiumLpMovements({
    transaction,
    tokenDeltas: [{ mintAddress: tokenMint, decimals: 6, amountRaw: '-4' }],
    pools: [tracked],
  }), []);
  assert.deepEqual(matchTrackedRaydiumLpMovements({
    transaction: { transaction: { message: { accountKeys: [] } } },
    tokenDeltas: [{ mintAddress: lpMint, decimals: 9, amountRaw: '-12' }],
    pools: [tracked],
  }), []);
});

test('rejects an invalid wallet address before making network requests', async () => {
  let requested = false;
  await assert.rejects(() => scanTrackedRaydiumLpPositions({
    walletAddress: 'bad-wallet',
    apiBase: 'http://wire.test',
    pools: [trackedPool()],
    fetcher: async () => {
      requested = true;
      return jsonResponse({});
    },
  }));
  assert.equal(requested, false);
});
