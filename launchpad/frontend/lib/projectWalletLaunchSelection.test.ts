import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  queueProjectWalletLaunchSelection,
  takeProjectWalletLaunchSelection,
} from './projectWalletLaunchSelection';

const wallets = [
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
];

function withSessionStorage(run: (values: Map<string, string>) => void) {
  const values = new Map<string, string>();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    },
  });
  try {
    run(values);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('queues and consumes a launch buy plan once for a token', () => {
  withSessionStorage(() => {
    queueProjectWalletLaunchSelection('pump-mint', {
      walletAddresses: wallets,
      buyAmounts: { [wallets[0]]: '0.025', [wallets[1]]: '0.125' },
      buyDelaySeconds: 5,
      buySlippageBps: 200,
    });

    assert.deepEqual(takeProjectWalletLaunchSelection('pump-mint'), {
      walletAddresses: wallets,
      buyAmounts: { [wallets[0]]: '0.025', [wallets[1]]: '0.125' },
      buyDelaySeconds: 5,
      buySlippageBps: 200,
    });
    assert.equal(takeProjectWalletLaunchSelection('pump-mint'), null);
  });
});

test('filters duplicate wallets and invalid amounts before restoring a queued plan', () => {
  withSessionStorage(() => {
    queueProjectWalletLaunchSelection('pump-mint', {
      walletAddresses: [wallets[0], wallets[0], wallets[1]],
      buyAmounts: { [wallets[0]]: '0.1', [wallets[1]]: '0.0000000001' },
      buyDelaySeconds: 3,
      buySlippageBps: 300,
    });

    assert.deepEqual(takeProjectWalletLaunchSelection('pump-mint'), {
      walletAddresses: wallets,
      buyAmounts: { [wallets[0]]: '0.1' },
      buyDelaySeconds: 0,
      buySlippageBps: 100,
    });
  });
});

test('an empty plan removes a previously queued selection', () => {
  withSessionStorage(() => {
    queueProjectWalletLaunchSelection('pump-mint', {
      walletAddresses: [wallets[0]],
      buyAmounts: { [wallets[0]]: '0.1' },
      buyDelaySeconds: 0,
      buySlippageBps: 100,
    });
    queueProjectWalletLaunchSelection('pump-mint', {
      walletAddresses: [],
      buyAmounts: {},
      buyDelaySeconds: 0,
      buySlippageBps: 100,
    });

    assert.equal(takeProjectWalletLaunchSelection('pump-mint'), null);
  });
});
