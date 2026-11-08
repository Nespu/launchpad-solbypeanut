import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRawAmount,
  parseDecimalToRaw,
  parseQuoteAsset,
  QUOTE_ASSETS,
} from '../src/services/poolQuoteAsset';

test('quote assets map to the expected Devnet mints and precisions', () => {
  assert.deepEqual(QUOTE_ASSETS.SOL, {
    mintAddress: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
  });
  assert.deepEqual(QUOTE_ASSETS.USDC, {
    mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'USDC',
    decimals: 6,
  });
});

test('quote asset parser defaults legacy requests to SOL and rejects unknown assets', () => {
  assert.equal(parseQuoteAsset(undefined), 'SOL');
  assert.equal(parseQuoteAsset('SOL'), 'SOL');
  assert.equal(parseQuoteAsset('USDC'), 'USDC');
  assert.throws(() => parseQuoteAsset('USDT'), /Unsupported pool quote asset/);
});

test('decimal parsing preserves exact integer raw amounts for SOL and USDC', () => {
  assert.equal(parseDecimalToRaw('0.000000001', 9), 1n);
  assert.equal(parseDecimalToRaw('1.234567', 6), 1_234_567n);
  assert.equal(parseDecimalToRaw('12345678901234567890.123456', 6), 12_345_678_901_234_567_890_123_456n);
});

test('raw amount formatting trims trailing zeroes without losing precision', () => {
  assert.equal(formatRawAmount(1n, 9), '0.000000001');
  assert.equal(formatRawAmount(12_340_000n, 6), '12.34');
  assert.equal(formatRawAmount(10_000_000n, 6), '10');
});

test('decimal parsing rejects zero, signs, exponent notation and excess precision', () => {
  for (const value of ['0', '0.000000', '-1', '+1', '1e-6', '1.0000001', ' 1']) {
    assert.throws(() => parseDecimalToRaw(value, 6), undefined, value);
  }
});
