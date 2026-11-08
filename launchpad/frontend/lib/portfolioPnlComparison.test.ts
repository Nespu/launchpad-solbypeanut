import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePortfolioExitToFifo, isPortfolioActivityComplete, type PortfolioFifoPosition } from './portfolioPnlComparison';

const position: PortfolioFifoPosition = {
  quoteMint: 'SOL_MINT',
  quoteDecimals: 9,
  tokenDecimals: 6,
  reconstructedTokenAmountRaw: '2500000',
  knownTokenAmountRaw: '2500000',
  knownCostBasisRaw: '90000000',
  unknownTokenAmountRaw: '0',
  incomplete: false,
};

const quote = { quoteMint: 'SOL_MINT', quoteDecimals: 9, amountOutRaw: '110000000' };

test('marks portfolio history incomplete when any activity source is missing or approximate', () => {
  const coverage = {
    externalActivityIncomplete: false,
    swapsUnavailable: false,
    swapsHasMore: false,
    withdrawalsUnavailable: false,
    withdrawalAmountsApproximate: false,
  };
  assert.equal(isPortfolioActivityComplete(coverage), true);
  for (const key of Object.keys(coverage) as Array<keyof typeof coverage>) {
    assert.equal(isPortfolioActivityComplete({ ...coverage, [key]: true }), false, `${key} must disable the comparison`);
  }
});

test('compares a full-balance quote to complete FIFO basis with exact integer arithmetic', () => {
  assert.deepEqual(comparePortfolioExitToFifo({
    currentBalanceRaw: '2500000',
    currentBalanceDecimals: 6,
    position,
    quote,
    activityComplete: true,
  }), {
    status: 'comparable',
    quoteMint: 'SOL_MINT',
    quoteDecimals: 9,
    differenceRaw: '20000000',
  });
});

test('refuses comparison when history, basis, balance, or quote asset does not fully match', () => {
  const common = { currentBalanceRaw: '2500000', currentBalanceDecimals: 6, position, quote, activityComplete: true };
  assert.equal(comparePortfolioExitToFifo({ ...common, activityComplete: false }).status, 'unavailable');
  assert.deepEqual(comparePortfolioExitToFifo({
    ...common,
    position: { ...position, unknownTokenAmountRaw: '1' },
  }), { status: 'unavailable', reason: 'incomplete-basis' });
  assert.deepEqual(comparePortfolioExitToFifo({ ...common, currentBalanceRaw: '2500001' }), { status: 'unavailable', reason: 'balance-mismatch' });
  assert.deepEqual(comparePortfolioExitToFifo({ ...common, quote: { ...quote, quoteMint: 'USDC_MINT' } }), { status: 'unavailable', reason: 'quote-mismatch' });
});
