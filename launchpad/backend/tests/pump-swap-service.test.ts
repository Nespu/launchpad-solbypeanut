import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { OnlinePumpSdk, bondingCurvePda } from '@pump-fun/pump-sdk';
import {
  canonicalPumpPoolPda,
  isPumpPool,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  pumpPoolAuthorityPda,
} from '@pump-fun/pump-swap-sdk';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { PublicError } from '../src/utils/publicError';
import { pumpAmmBuyLimits, resolvePumpVenue } from '../src/services/pumpAmmSwapService';
import { applyQuoteInputSlippage } from '../src/services/pumpSwapService';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function connectionWithAccount(account: AccountInfo<Buffer> | null, calls: PublicKey[] = []): Connection {
  return {
    getAccountInfo: async (address: PublicKey) => {
      calls.push(address);
      return account;
    },
  } as unknown as Connection;
}

function activeCurve() {
  return {
    complete: false,
    realQuoteReserves: new BN(1),
    virtualQuoteReserves: new BN(1),
    realTokenReserves: new BN(1),
    virtualTokenReserves: new BN(1),
  };
}

function emptyAccount(owner: PublicKey): AccountInfo<Buffer> {
  return { data: Buffer.alloc(0), executable: false, lamports: 1, owner, rentEpoch: 0 };
}

test('PumpSwap exact-output buy quote exposes its true output floor and maximum quote spend', () => {
  const baseOut = new BN(987_654);
  const maxQuote = new BN(1_020_000_000);
  assert.deepEqual(pumpAmmBuyLimits({ base: baseOut, maxQuote }), {
    minimumAmountOut: baseOut,
    maximumAmountIn: maxQuote,
  });
});

test('Pump bonding-curve buy cap applies the same integer slippage rounding as buy_v2', () => {
  const quoteAmount = new BN(1_000_000_000);
  assert.equal(applyQuoteInputSlippage(quoteAmount, 50).toString(), '1005000000');
  assert.equal(applyQuoteInputSlippage(quoteAmount, 100).toString(), '1010000000');
  assert.equal(applyQuoteInputSlippage(quoteAmount, 200).toString(), '1020000000');
  assert.equal(applyQuoteInputSlippage(quoteAmount, 500).toString(), '1050000000');
});

test('Pump venue resolution rejects a bonding-curve address that is not canonical', async () => {
  const mint = Keypair.generate().publicKey;
  const calls: PublicKey[] = [];

  await assert.rejects(
    resolvePumpVenue(connectionWithAccount(null, calls), mint.toBase58(), PublicKey.default.toBase58()),
    (error: unknown) => error instanceof PublicError && error.status === 409,
  );
  assert.equal(calls.length, 0);
});

test('Pump venue resolution selects the active bonding curve before graduation', async () => {
  const mint = Keypair.generate().publicKey;
  const expectedCurve = bondingCurvePda(mint);
  const originalFetch = OnlinePumpSdk.prototype.fetchBondingCurve;
  OnlinePumpSdk.prototype.fetchBondingCurve = async () => activeCurve() as never;
  try {
    const venue = await resolvePumpVenue(connectionWithAccount(null), mint.toBase58(), expectedCurve.toBase58());
    assert.deepEqual(venue, { venue: 'PUMP_FUN', marketAddress: expectedCurve.toBase58() });
  } finally {
    OnlinePumpSdk.prototype.fetchBondingCurve = originalFetch;
  }
});

test('Pump venue resolution reports a graduated curve while its canonical pool is absent', async () => {
  const mint = Keypair.generate().publicKey;
  const expectedCurve = bondingCurvePda(mint);
  const originalFetch = OnlinePumpSdk.prototype.fetchBondingCurve;
  OnlinePumpSdk.prototype.fetchBondingCurve = async () => ({ complete: true }) as never;
  try {
    await assert.rejects(
      resolvePumpVenue(connectionWithAccount(null), mint.toBase58(), expectedCurve.toBase58()),
      (error: unknown) => error instanceof PublicError
        && error.status === 409
        && error.message.includes('todavía no aparece'),
    );
  } finally {
    OnlinePumpSdk.prototype.fetchBondingCurve = originalFetch;
  }
});

test('Pump venue resolution rejects an account at the canonical address owned by another program', async () => {
  const mint = Keypair.generate().publicKey;
  const expectedCurve = bondingCurvePda(mint);
  const poolAddress = canonicalPumpPoolPda(mint, SOL_MINT);
  const venueConnection = connectionWithAccount(emptyAccount(PublicKey.default));

  await assert.rejects(
    resolvePumpVenue(venueConnection, mint.toBase58(), expectedCurve.toBase58()),
    (error: unknown) => error instanceof PublicError
      && error.status === 409
      && error.message.includes('programa oficial'),
  );
  assert.equal(poolAddress.equals(PublicKey.default), false);
});

test('Pump venue resolution recognizes only the official canonical PumpSwap SOL pool', async () => {
  const mint = Keypair.generate().publicKey;
  const expectedCurve = bondingCurvePda(mint);
  const poolAddress = canonicalPumpPoolPda(mint, SOL_MINT);
  const pool = {
    baseMint: mint,
    quoteMint: SOL_MINT,
    creator: pumpPoolAuthorityPda(mint),
  };
  assert.equal(isPumpPool(pool.baseMint, pool.creator), true);

  const sdkPrototype = Object.getPrototypeOf(PUMP_AMM_SDK) as {
    decodePoolNullable: (account: AccountInfo<Buffer>) => unknown;
  };
  const originalDecode = sdkPrototype.decodePoolNullable;
  sdkPrototype.decodePoolNullable = () => pool;
  try {
    const venue = await resolvePumpVenue(
      connectionWithAccount(emptyAccount(PUMP_AMM_PROGRAM_ID)),
      mint.toBase58(),
      expectedCurve.toBase58(),
    );
    assert.deepEqual(venue, { venue: 'PUMP_SWAP', marketAddress: poolAddress.toBase58() });
  } finally {
    sdkPrototype.decodePoolNullable = originalDecode;
  }
});
