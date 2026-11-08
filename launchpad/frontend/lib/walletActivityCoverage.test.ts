import assert from 'node:assert/strict';
import test from 'node:test';
import { isWalletActivityCoveragePartial } from './walletActivityCoverage';

const completeScan = {
  signatureBacklogCount: 0,
  sourceHasMore: false,
  signatureScanIncomplete: false,
  transactionDetailsUnavailable: false,
};

test('coverage becomes complete after every source page and transaction detail loads', () => {
  assert.equal(isWalletActivityCoveragePartial(completeScan), false);
});

test('coverage stays partial while merged signatures remain in the page backlog', () => {
  assert.equal(isWalletActivityCoveragePartial({ ...completeScan, signatureBacklogCount: 1 }), true);
});

test('coverage stays partial while any wallet or token-account source has another page', () => {
  assert.equal(isWalletActivityCoveragePartial({ ...completeScan, sourceHasMore: true }), true);
});

test('coverage stays partial when a source or transaction detail request fails', () => {
  assert.equal(isWalletActivityCoveragePartial({ ...completeScan, signatureScanIncomplete: true }), true);
  assert.equal(isWalletActivityCoveragePartial({ ...completeScan, transactionDetailsUnavailable: true }), true);
});
