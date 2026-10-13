import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWithdrawalAmounts } from '../src/services/withdrawalMath';

const SOL = 1_000_000_000n;
const supply = 10_000n;
const solReserve = 100n * SOL;
const tokenReserve = 1_000_000_000_000n;

for (const percent of [25, 50, 75, 95]) {
  test(`withdrawal math splits ${percent}% pro-rata output into 90/10`, () => {
    const lpAmount = (supply * BigInt(percent)) / 100n;
    const result = calculateWithdrawalAmounts({
      lpAmountRaw: String(lpAmount),
      lpSupplyRaw: String(supply),
      baseReserveRaw: String(tokenReserve),
      quoteReserveRaw: String(solReserve),
      solIsBase: false,
    });

    const expectedTotalSolLamports = (solReserve * BigInt(percent)) / 100n;
    const expectedFee = (expectedTotalSolLamports * 10n) / 100n;
    assert.equal(result.totalSolOutLamports, expectedTotalSolLamports);
    assert.equal(result.platformFeeLamports, expectedFee);
    assert.equal(result.userAmountLamports, expectedTotalSolLamports - expectedFee);
    assert.equal(result.platformFeeLamports + result.userAmountLamports, result.totalSolOutLamports);
  });
}

test('withdrawal math chooses the SOL reserve correctly for either mint ordering', () => {
  const input = {
    lpAmountRaw: '2500',
    lpSupplyRaw: '10000',
    baseReserveRaw: String(solReserve),
    quoteReserveRaw: String(tokenReserve),
    solIsBase: true,
  };
  const solAsBase = calculateWithdrawalAmounts(input);
  const solAsQuote = calculateWithdrawalAmounts({
    ...input,
    baseReserveRaw: String(tokenReserve),
    quoteReserveRaw: String(solReserve),
    solIsBase: false,
  });

  assert.equal(solAsBase.totalSolOutLamports, 25n * SOL);
  assert.equal(solAsQuote.totalSolOutLamports, 25n * SOL);
  assert.equal(solAsBase.platformFeeLamports, solAsQuote.platformFeeLamports);
});

test('withdrawal math floors both pro-rata reserves before applying the 1% minimum', () => {
  const result = calculateWithdrawalAmounts({
    lpAmountRaw: '1',
    lpSupplyRaw: '3',
    baseReserveRaw: '10',
    quoteReserveRaw: '101',
    solIsBase: true,
  });

  assert.equal(result.baseMinAmountRaw, 2n); // floor(10 / 3) = 3; floor(3 * .99) = 2
  assert.equal(result.quoteMinAmountRaw, 32n);
});

test('withdrawal math keeps large raw amounts exact with BigInt', () => {
  const result = calculateWithdrawalAmounts({
    lpAmountRaw: '9007199254740993',
    lpSupplyRaw: '10000000000000000',
    baseReserveRaw: '20000000000000000',
    quoteReserveRaw: '10000000000000000',
    solIsBase: false,
  });

  assert.equal(result.totalSolOutLamports, 9007199254740993n);
  assert.equal(result.platformFeeLamports, 900719925474099n);
  assert.equal(result.userAmountLamports, 8106479329266894n);
});

test('withdrawal math rejects zero, malformed, and over-supply LP amounts', () => {
  const base = { lpSupplyRaw: '100', baseReserveRaw: '1000', quoteReserveRaw: '1000', solIsBase: true };
  assert.throws(() => calculateWithdrawalAmounts({ ...base, lpAmountRaw: '0' }), /greater than zero/);
  assert.throws(() => calculateWithdrawalAmounts({ ...base, lpAmountRaw: '101' }), /cannot exceed/);
  assert.throws(() => calculateWithdrawalAmounts({ ...base, lpAmountRaw: '-1' }), /non-negative integer/);
  assert.throws(() => calculateWithdrawalAmounts({ ...base, lpAmountRaw: '1', lpSupplyRaw: '0' }), /greater than zero/);
});
