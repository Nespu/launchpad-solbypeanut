import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseTimedBuyDelaySeconds } from './timedBuyDelay';

test('chooses an inclusive delay within the configured Timed Buys range', () => {
  assert.equal(chooseTimedBuyDelaySeconds(2, 5, 0), 2);
  assert.equal(chooseTimedBuyDelaySeconds(2, 5, 0.5), 4);
  assert.equal(chooseTimedBuyDelaySeconds(2, 5, 0.999999), 5);
  assert.equal(chooseTimedBuyDelaySeconds(4, 4, 0.3), 4);
  assert.equal(chooseTimedBuyDelaySeconds(0, 30, 0.999999), 30);
});

test('rejects invalid Timed Buys delay ranges and random samples', () => {
  assert.throws(() => chooseTimedBuyDelaySeconds(-1, 5, 0.5), /range is invalid/);
  assert.throws(() => chooseTimedBuyDelaySeconds(6, 5, 0.5), /range is invalid/);
  assert.throws(() => chooseTimedBuyDelaySeconds(0, 31, 0.5), /range is invalid/);
  assert.throws(() => chooseTimedBuyDelaySeconds(0.5, 5, 0.5), /range is invalid/);
  assert.throws(() => chooseTimedBuyDelaySeconds(0, 5, 1), /range is invalid/);
});
