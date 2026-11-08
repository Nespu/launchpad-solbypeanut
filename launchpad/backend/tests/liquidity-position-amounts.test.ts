import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateLiquidityPositionAmounts, type LiquidityPositionReserve } from '../src/services/liquidityPositionAmounts';

const reserveA: LiquidityPositionReserve = {
  mintAddress: 'MintA',
  symbol: 'TOK',
  decimals: 6,
  reserveRaw: '10000000000000000001',
};
const reserveB: LiquidityPositionReserve = {
  mintAddress: 'MintB',
  symbol: 'SOL',
  decimals: 9,
  reserveRaw: '7000000001',
};

test('calculates each reserve share with integer precision and floors fractional raw units', () => {
  assert.deepEqual(calculateLiquidityPositionAmounts({
    lpAmountRaw: '1',
    lpSupplyRaw: '3',
    reserves: [reserveA, reserveB],
  }), [
    { ...reserveA, amountRaw: '3333333333333333333' },
    { ...reserveB, amountRaw: '2333333333' },
  ]);
});

test('returns the complete current reserves when the wallet holds the full LP supply', () => {
  assert.deepEqual(calculateLiquidityPositionAmounts({
    lpAmountRaw: '99',
    lpSupplyRaw: '99',
    reserves: [reserveA, reserveB],
  }), [
    { ...reserveA, amountRaw: reserveA.reserveRaw },
    { ...reserveB, amountRaw: reserveB.reserveRaw },
  ]);
});

test('rejects zero or over-supply LP balances and malformed integer values', () => {
  assert.throws(() => calculateLiquidityPositionAmounts({ lpAmountRaw: '0', lpSupplyRaw: '1', reserves: [reserveA, reserveB] }));
  assert.throws(() => calculateLiquidityPositionAmounts({ lpAmountRaw: '2', lpSupplyRaw: '1', reserves: [reserveA, reserveB] }));
  assert.throws(() => calculateLiquidityPositionAmounts({ lpAmountRaw: '1.5', lpSupplyRaw: '2', reserves: [reserveA, reserveB] }));
  assert.throws(() => calculateLiquidityPositionAmounts({ lpAmountRaw: '1', lpSupplyRaw: '0', reserves: [reserveA, reserveB] }));
});

test('rejects malformed reserves and unsupported decimal precision', () => {
  assert.throws(() => calculateLiquidityPositionAmounts({
    lpAmountRaw: '1',
    lpSupplyRaw: '1',
    reserves: [{ ...reserveA, reserveRaw: '-1' }, reserveB],
  }));
  assert.throws(() => calculateLiquidityPositionAmounts({
    lpAmountRaw: '1',
    lpSupplyRaw: '1',
    reserves: [{ ...reserveA, decimals: 19 }, reserveB],
  }));
});
