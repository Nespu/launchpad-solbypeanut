import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  applyEqualProjectWalletBuyAmount,
  sumProjectWalletBuyAmounts,
} from './projectWalletBuyAllocation';

const wallets = [
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
];

test('applies the same validated SOL amount to each selected project wallet', () => {
  assert.deepEqual(applyEqualProjectWalletBuyAmount(wallets, '0.025000000'), {
    [wallets[0]]: '0.025000000',
    [wallets[1]]: '0.025000000',
  });
});

test('sums custom wallet amounts exactly in lamports', () => {
  assert.equal(sumProjectWalletBuyAmounts(wallets, {
    [wallets[0]]: '0.123456789',
    [wallets[1]]: '0.1',
  }), '0.223456789');
});

test('rejects invalid amounts, duplicate wallets and selections above the limit', () => {
  assert.throws(() => applyEqualProjectWalletBuyAmount(wallets, '0'), RangeError);
  assert.throws(() => applyEqualProjectWalletBuyAmount(wallets, '0.0000000001'), RangeError);
  assert.throws(() => applyEqualProjectWalletBuyAmount([wallets[0], wallets[0]], '0.1'), RangeError);
  const tooManyWallets = Array.from({ length: 11 }, (_, index) => new PublicKey(new Uint8Array(32).fill(index + 1)).toBase58());
  assert.throws(() => applyEqualProjectWalletBuyAmount(tooManyWallets, '0.1'), RangeError);
});
