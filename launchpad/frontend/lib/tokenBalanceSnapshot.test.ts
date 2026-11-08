import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateParsedTokenBalances } from './tokenBalanceSnapshot';

function parsedAccount(mint: string, amount: string, decimals: number) {
  return {
    account: {
      data: {
        program: 'spl-token',
        parsed: { info: { mint, tokenAmount: { amount, decimals } } },
        space: 165,
      },
    },
  };
}

test('sums parsed balances across SPL programs by mint without floating point', () => {
  const balances = aggregateParsedTokenBalances([
    [parsedAccount('MintA', '9007199254740993', 9), parsedAccount('MintB', '1200', 6)],
    [parsedAccount('MintA', '7', 9)],
  ]);

  assert.deepEqual([...balances.entries()], [
    ['MintA', { amountRaw: '9007199254741000', decimals: 9 }],
    ['MintB', { amountRaw: '1200', decimals: 6 }],
  ]);
});

test('returns an empty snapshot only when both completed account lists are empty', () => {
  assert.equal(aggregateParsedTokenBalances([[], []]).size, 0);
});

test('rejects an unparsed or malformed account instead of silently reporting a zero balance', () => {
  assert.throws(() => aggregateParsedTokenBalances([[], [{ account: { data: 'base64' } }]]));
  assert.throws(() => aggregateParsedTokenBalances([[parsedAccount('MintA', 'not-a-number', 9)]]));
});

test('rejects conflicting decimals for the same mint', () => {
  assert.throws(() => aggregateParsedTokenBalances([[
    parsedAccount('MintA', '10', 6),
    parsedAccount('MintA', '20', 9),
  ]]));
});
