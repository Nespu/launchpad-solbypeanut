import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import type { VaultWallet } from './walletVault';
import {
  canReQuoteFailedProjectSwap,
  canContinueTimedBuyAfterFailure,
  isProjectMarketWatchQuote,
  listSavedProjectWalletSwapTasks,
  parseProjectWalletSwapTask,
  projectWalletSwapTaskStorageKey,
  serializeProjectWalletSwapTask,
  type ProjectSwapTask,
} from './projectWalletSwapTask';

const mintAddress = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const quoteMint = 'So11111111111111111111111111111111111111112';
const wallet: VaultWallet = {
  address: '11111111111111111111111111111111',
  label: 'Wallet 1',
  role: 'trading',
  createdAt: 1,
};
const signature = bs58.encode(new Uint8Array(64).fill(7));

test('accepts a current Devnet quote for the watched launch and exact sample amount', () => {
  const quote = createTask().rows[0].quote;
  const context = { mintAddress, quoteMint, launchPlatform: 'RAYDIUM' as const, amountIn: '0.10', slippageBps: 100 };
  assert.equal(isProjectMarketWatchQuote(quote, context), true);
  assert.equal(isProjectMarketWatchQuote({ ...quote, amountIn: '0.2' }, context), false);
  assert.equal(isProjectMarketWatchQuote({ ...quote, network: 'Solana Mainnet' }, context), false);
  assert.equal(isProjectMarketWatchQuote({ ...quote, outputMint: quoteMint }, context), false);
  assert.equal(isProjectMarketWatchQuote({ ...quote, venue: 'PUMP_SWAP' }, context), false);
  assert.equal(isProjectMarketWatchQuote({ ...quote, venue: 'PUMP_SWAP' }, { ...context, launchPlatform: 'PUMP_FUN' }), true);
});

function createTask(): ProjectSwapTask {
  return {
    side: 'buy',
    slippageBps: 100,
    delayMinSeconds: 2,
    delayMaxSeconds: 5,
    maxConsecutiveErrors: 1,
    delayUntil: null,
    maxTotalSpend: '0.12',
    selected: [wallet.address],
    amounts: { [wallet.address]: '0.1' },
    rows: [{
      wallet,
      amountIn: '0.1',
      quote: {
        venue: 'RAYDIUM',
        poolAddress: wallet.address,
        side: 'buy',
        inputMint: quoteMint,
        outputMint: mintAddress,
        inputSymbol: 'SOL',
        outputSymbol: 'TEST',
        quoteMint,
        quoteDecimals: 9,
        amountIn: '0.1',
        amountOut: '100',
        minimumAmountOut: '99',
        maximumAmountIn: '0.11',
        estimatedPoolFee: '0.003',
        priceImpactPercent: '0.1',
        slippageBps: 100,
        network: 'Solana Devnet',
      },
      networkFeeLamports: '5000',
      status: 'reviewed',
    }],
  };
}

function save(task: ProjectSwapTask) {
  return serializeProjectWalletSwapTask(task, { mintAddress, quoteMint, launchPlatform: 'RAYDIUM' }, 1);
}

test('restores a reviewed task only for its matching token, quote mint, platform and vault wallet', () => {
  const raw = save(createTask());
  assert.doesNotMatch(raw, /secretKey|privateKey|signedTransaction|serializedTransaction/i);
  assert.doesNotMatch(raw, /timedBuyArmed|automationEnabled/i);
  assert.equal(raw.includes(wallet.label), false);
  const restored = parseProjectWalletSwapTask(raw, { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.rows[0].status, 'reviewed');
  assert.equal(restored?.rows[0].wallet.address, wallet.address);
  assert.equal(restored?.delayMinSeconds, 2);
  assert.equal(restored?.delayMaxSeconds, 5);
  assert.equal(parseProjectWalletSwapTask(raw, { mintAddress, quoteMint, launchPlatform: 'PUMP_FUN', wallets: [wallet] }), null);
  assert.equal(parseProjectWalletSwapTask(raw, { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [] }), null);
});

test('preserves explicitly cancelled wallet rows without restoring them as actionable', () => {
  const task = createTask();
  task.rows[0].status = 'cancelled';
  task.rows[0].detail = 'Cancelled before signing.';
  const raw = save(task);
  const restored = parseProjectWalletSwapTask(raw, { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.rows[0].status, 'cancelled');
  assert.equal(restored?.rows[0].signature, undefined);
  assert.equal(restored?.rows[0].detail, 'Cancelada antes de firmar. No se envió ninguna transacción.');
});

test('preserves a validated failure reason for the task execution results', () => {
  const task = createTask();
  task.rows[0].status = 'failed';
  task.rows[0].detail = 'La transacción falló en Devnet.';
  const raw = save(task);
  const restored = parseProjectWalletSwapTask(raw, { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.rows[0].detail, task.rows[0].detail);

  const oversized = JSON.parse(raw) as { rows: Array<Record<string, unknown>> };
  oversized.rows[0].detail = 'x'.repeat(501);
  assert.equal(parseProjectWalletSwapTask(JSON.stringify(oversized), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] }), null);
});

test('restores every stored signature as pending and never as an approved or completed operation', () => {
  const task = createTask();
  task.rows[0] = { ...task.rows[0], status: 'confirmed', signature };
  const restored = parseProjectWalletSwapTask(save(task), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.rows[0].status, 'pending');
  assert.equal(restored?.rows[0].signature, signature);
});

test('restores a still-active buy delay after a reload', () => {
  const task = createTask();
  task.delayUntil = Date.now() + 20_000;
  const restored = parseProjectWalletSwapTask(save(task), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.delayUntil, task.delayUntil);
});

test('restores task lifecycle state but never resumes a persisted running task', () => {
  const running = createTask();
  running.runStatus = 'running';
  assert.equal(parseProjectWalletSwapTask(save(running), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] })?.runStatus, 'paused');

  for (const runStatus of ['ready', 'paused', 'completed', 'failed'] as const) {
    const task = createTask();
    task.runStatus = runStatus;
    assert.equal(parseProjectWalletSwapTask(save(task), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] })?.runStatus, runStatus);
  }

  const stopped = createTask();
  stopped.runStatus = 'stopped';
  assert.equal(parseProjectWalletSwapTask(save(stopped), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] })?.runStatus, 'stopped');

  const invalid = JSON.parse(save(createTask())) as Record<string, unknown>;
  invalid.runStatus = 'auto-resume';
  assert.equal(parseProjectWalletSwapTask(JSON.stringify(invalid), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] }), null);
});

test('migrates v1 fixed-delay reviews to an equal min/max delay range', () => {
  const oldTask = JSON.parse(save(createTask())) as Record<string, unknown>;
  oldTask.version = 1;
  oldTask.delaySeconds = 5;
  delete oldTask.delayMinSeconds;
  delete oldTask.delayMaxSeconds;
  delete oldTask.maxConsecutiveErrors;
  const restored = parseProjectWalletSwapTask(JSON.stringify(oldTask), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.delayMinSeconds, 5);
  assert.equal(restored?.delayMaxSeconds, 5);
  assert.equal(restored?.maxConsecutiveErrors, 1);
});

test('preserves the configured consecutive-error threshold in a reviewed task', () => {
  const task = createTask();
  task.maxConsecutiveErrors = 4;
  const restored = parseProjectWalletSwapTask(save(task), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.maxConsecutiveErrors, 4);
});

test('continues only after a confirmed failure below the configured threshold and with another reviewed wallet', () => {
  assert.equal(canContinueTimedBuyAfterFailure(1, 2, true), true);
  assert.equal(canContinueTimedBuyAfterFailure(2, 2, true), false);
  assert.equal(canContinueTimedBuyAfterFailure(1, 2, false), false);
  assert.equal(canContinueTimedBuyAfterFailure(1, 0, true), false);
  assert.equal(canContinueTimedBuyAfterFailure(1, 6, true), false);
});

test('allows a manual retry quote only for a failed wallet when no signature is pending', () => {
  assert.equal(canReQuoteFailedProjectSwap('failed', false), true);
  assert.equal(canReQuoteFailedProjectSwap('failed', true), false);
  assert.equal(canReQuoteFailedProjectSwap('pending', false), false);
  assert.equal(canReQuoteFailedProjectSwap('confirmed', false), false);
  assert.equal(canReQuoteFailedProjectSwap('reviewed', false), false);
});

test('rejects an invalid persisted delay range', () => {
  const invalid = JSON.parse(save(createTask())) as Record<string, unknown>;
  invalid.delayMinSeconds = 10;
  invalid.delayMaxSeconds = 5;
  assert.equal(parseProjectWalletSwapTask(JSON.stringify(invalid), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] }), null);
});

test('rejects a persisted consecutive-error threshold outside the supported range', () => {
  const invalid = JSON.parse(save(createTask())) as Record<string, unknown>;
  invalid.maxConsecutiveErrors = 6;
  assert.equal(parseProjectWalletSwapTask(JSON.stringify(invalid), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] }), null);
});

test('drops an elapsed delay and rejects an implausibly long stored delay', () => {
  const elapsed = createTask();
  elapsed.delayUntil = Date.now() - 1_000;
  const elapsedRestored = parseProjectWalletSwapTask(save(elapsed), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(elapsedRestored?.delayUntil, null);

  const implausible = createTask();
  implausible.delayUntil = Date.now() + 120_000;
  assert.equal(parseProjectWalletSwapTask(save(implausible), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] }), null);
});

test('restores but blocks a stored review whose maximum spend exceeds its saved budget', () => {
  const task = createTask();
  task.maxTotalSpend = '0.10';
  const restored = parseProjectWalletSwapTask(save(task), { mintAddress, quoteMint, launchPlatform: 'RAYDIUM', wallets: [wallet] });
  assert.equal(restored?.rows[0].blockedByBudget, true);
});

test('scopes saved reviews to the token, quote mint and launch platform', () => {
  assert.notEqual(
    projectWalletSwapTaskStorageKey(mintAddress, quoteMint, 'RAYDIUM'),
    projectWalletSwapTaskStorageKey(mintAddress, quoteMint, 'PUMP_FUN'),
  );
  assert.notEqual(
    projectWalletSwapTaskStorageKey(mintAddress, quoteMint, 'RAYDIUM'),
    projectWalletSwapTaskStorageKey(mintAddress, wallet.address, 'RAYDIUM'),
  );
});

test('lists only strictly parsed saved tasks for wallets that still exist in the vault', () => {
  const validKey = projectWalletSwapTaskStorageKey(mintAddress, quoteMint, 'RAYDIUM');
  const entries = new Map<string, string>([
    [validKey, save(createTask())],
    [`${validKey}:unexpected`, save(createTask())],
    ['wire:project-wallet-swap-task:v1:RAYDIUM:bad-mint:bad-quote', save(createTask())],
  ]);
  const storage = {
    get length() { return entries.size; },
    key(index: number) { return Array.from(entries.keys())[index] ?? null; },
    getItem(key: string) { return entries.get(key) ?? null; },
  };

  const listed = listSavedProjectWalletSwapTasks([wallet], storage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].storageKey, validKey);
  assert.equal(listed[0].mintAddress, mintAddress);
  assert.equal(listed[0].quoteMint, quoteMint);
  assert.equal(listed[0].launchPlatform, 'RAYDIUM');
  assert.equal(listed[0].task.rows[0].wallet.address, wallet.address);
  assert.equal(listSavedProjectWalletSwapTasks([], storage).length, 0);
});
