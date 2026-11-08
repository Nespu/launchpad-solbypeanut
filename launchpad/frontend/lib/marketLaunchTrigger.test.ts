import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMarketLaunchFeeReserveWithinCap,
  isMarketLaunchTriggerExpired,
  marketLaunchPlanFingerprint,
  MARKET_LAUNCH_TRIGGER_POLL_INTERVAL_MS,
  MARKET_LAUNCH_TRIGGER_TTL_MS,
  MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS,
} from './marketLaunchTrigger';

test('the launch trigger expires at its fixed deadline and cannot be resumed from a missing deadline', () => {
  assert.equal(MARKET_LAUNCH_TRIGGER_POLL_INTERVAL_MS, 5_000);
  const now = 10_000;
  const expiresAt = now + MARKET_LAUNCH_TRIGGER_TTL_MS;
  assert.equal(isMarketLaunchTriggerExpired(expiresAt, now), false);
  assert.equal(isMarketLaunchTriggerExpired(expiresAt, expiresAt), true);
  assert.equal(isMarketLaunchTriggerExpired(null, now), true);
  assert.equal(isMarketLaunchTriggerExpired(Number.NaN, now), true);
});

test('launch-trigger fees and account reserve stay under the per-wallet SOL cap', () => {
  assert.equal(isMarketLaunchFeeReserveWithinCap(['5000', '1000000']), true);
  assert.equal(isMarketLaunchFeeReserveWithinCap([
    String(MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS - 10_000_000n),
  ]), true);
  assert.equal(isMarketLaunchFeeReserveWithinCap([
    String(MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS - 10_000_000n + 1n),
  ]), false);
  assert.equal(isMarketLaunchFeeReserveWithinCap(['-1']), false);
  assert.equal(isMarketLaunchFeeReserveWithinCap([]), false);
});

test('launch authorization fingerprints every wallet, amount, cap, slippage, delay, token, and market in order', () => {
  const plan = {
    mintAddress: 'mint-a',
    quoteMint: 'sol',
    launchPlatform: 'RAYDIUM' as const,
    side: 'buy' as const,
    selected: ['wallet-a', 'wallet-b'],
    amounts: { 'wallet-a': '0.1', 'wallet-b': '0.2' },
    maxTotalSpend: '0.3',
    slippageBps: 100,
    delayMinSeconds: 1,
    delayMaxSeconds: 5,
    maxConsecutiveErrors: 1,
  };
  const fingerprint = marketLaunchPlanFingerprint(plan);
  assert.equal(marketLaunchPlanFingerprint({ ...plan, maxTotalSpend: ' 0.3 ' }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, mintAddress: 'mint-b' }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, quoteMint: 'usdc' }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, launchPlatform: 'PUMP_FUN' }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, selected: ['wallet-b', 'wallet-a'] }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, amounts: { ...plan.amounts, 'wallet-a': '0.15' } }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, maxTotalSpend: '0.31' }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, slippageBps: 200 }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, delayMinSeconds: 0 }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, delayMaxSeconds: 6 }), fingerprint);
  assert.notEqual(marketLaunchPlanFingerprint({ ...plan, maxConsecutiveErrors: 2 }), fingerprint);
});
