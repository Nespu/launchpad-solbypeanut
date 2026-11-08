import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPositiveDecimalAmount,
  parseTokenSellAlert,
  serializeTokenSellAlert,
  shouldTriggerTokenSellAlert,
  tokenSellAlertStorageKey,
} from './tokenSellAlert';

const context = {
  mintAddress: 'TokenMint111111111111111111111111111111111',
  quoteMint: 'So11111111111111111111111111111111111111112',
  tokenDecimals: 6,
  quoteDecimals: 9,
};

test('validates positive amounts at the exact asset precision', () => {
  assert.equal(isPositiveDecimalAmount('1.000001', 6), true);
  assert.equal(isPositiveDecimalAmount('1.0000001', 6), false);
  assert.equal(isPositiveDecimalAmount('0', 9), false);
  assert.equal(isPositiveDecimalAmount('0.000000001', 9), true);
});

test('compares sale proceeds with integer precision at and around the target', () => {
  assert.equal(shouldTriggerTokenSellAlert('0.100000000', '0.1', 9), true);
  assert.equal(shouldTriggerTokenSellAlert('0.099999999', '0.1', 9), false);
  assert.equal(shouldTriggerTokenSellAlert('1.000001', '1', 6), true);
  assert.equal(shouldTriggerTokenSellAlert('invalid', '1', 6), false);
});

test('persists and restores only an alert matching the token and quote asset', () => {
  const alert = { amountIn: '25.5', minimumAmountOut: '0.75', status: 'armed' as const };
  const raw = serializeTokenSellAlert(alert, context);
  assert.ok(raw);
  assert.deepEqual(parseTokenSellAlert(raw, context), alert);
  assert.equal(parseTokenSellAlert(raw, { ...context, mintAddress: 'OtherMint11111111111111111111111111111111' }), null);
  assert.equal(tokenSellAlertStorageKey(context), 'wire:token-sell-alert:v1:' + context.mintAddress + ':' + context.quoteMint);
});

test('rejects malformed, altered, or invalid triggered alert storage', () => {
  assert.equal(parseTokenSellAlert('{', context), null);
  assert.equal(serializeTokenSellAlert({ amountIn: '0', minimumAmountOut: '1', status: 'armed' }, context), null);
  assert.equal(parseTokenSellAlert(JSON.stringify({
    version: 1,
    mintAddress: context.mintAddress,
    quoteMint: context.quoteMint,
    amountIn: '1',
    minimumAmountOut: '1',
    status: 'triggered',
    triggeredAt: -1,
  }), context), null);
});
