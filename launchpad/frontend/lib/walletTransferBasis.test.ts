import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWalletTransferBasis,
  readWalletTransferBasis,
  upsertWalletTransferBasis,
  walletTransferBasisKey,
  walletTransferBasisTransferKey,
  writeWalletTransferBasis,
  type StoredWalletTransferBasisLot,
} from './walletTransferBasis';

const record: StoredWalletTransferBasisLot = {
  signature: '1'.repeat(88),
  slot: '2',
  blockTime: null,
  mintAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  sourceWalletAddress: '11111111111111111111111111111111',
  destinationWalletAddress: 'ComputeBudget111111111111111111111111111111',
  quoteMint: 'So11111111111111111111111111111111111111112',
  quoteDecimals: 9,
  lotIndex: 0,
  tokenAmountRaw: '25',
  transferAmountRaw: '25',
  quoteAmountRaw: '0',
  savedAt: 100,
};

test('parses only valid, unique local transfer basis records', () => {
  const records = parseWalletTransferBasis({ version: 1, records: [
    record,
    { ...record, tokenAmountRaw: '7' },
    { ...record, destinationWalletAddress: record.sourceWalletAddress },
    { ...record, quoteDecimals: 19 },
  ] });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.tokenAmountRaw, '25');
});

test('upserts a re-derived record by transaction, mint, wallet pair, and quote mint', () => {
  const basis = {
    signature: record.signature,
    slot: record.slot,
    blockTime: record.blockTime,
    mintAddress: record.mintAddress,
    sourceWalletAddress: record.sourceWalletAddress,
    destinationWalletAddress: record.destinationWalletAddress,
    quoteMint: record.quoteMint,
    quoteDecimals: record.quoteDecimals,
    lotIndex: record.lotIndex,
    transferAmountRaw: record.transferAmountRaw,
  };
  const updated = upsertWalletTransferBasis([record], [{ ...basis, tokenAmountRaw: '4', quoteAmountRaw: '8' }], [], 200);

  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.tokenAmountRaw, '4');
  assert.equal(updated[0]?.quoteAmountRaw, '8');
  assert.equal(updated[0]?.savedAt, 200);
  assert.equal(walletTransferBasisKey(updated[0]!), walletTransferBasisKey(record));
});

test('replacing one transfer removes stale FIFO lots from an earlier calculation', () => {
  const oldSecondLot = { ...record, lotIndex: 1, tokenAmountRaw: '5', quoteAmountRaw: '9' };
  const candidate = {
    signature: record.signature,
    slot: record.slot,
    blockTime: record.blockTime,
    mintAddress: record.mintAddress,
    sourceWalletAddress: record.sourceWalletAddress,
    destinationWalletAddress: record.destinationWalletAddress,
    quoteMint: record.quoteMint,
    quoteDecimals: record.quoteDecimals,
    lotIndex: 0,
    tokenAmountRaw: '4',
    transferAmountRaw: record.transferAmountRaw,
    quoteAmountRaw: '8',
  };
  const updated = upsertWalletTransferBasis(
    [record, oldSecondLot],
    [candidate],
    [walletTransferBasisTransferKey(record)],
    300,
  );

  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.lotIndex, 0);
  assert.equal(updated[0]?.tokenAmountRaw, '4');
});

test('reads malformed browser data as empty and writes a versioned local snapshot', () => {
  const values = new Map<string, string>([['wire:wallet-transfer-basis:v1', '{broken']]);
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };

  assert.deepEqual(readWalletTransferBasis(storage), []);
  assert.equal(writeWalletTransferBasis([record], storage), true);
  assert.deepEqual(readWalletTransferBasis(storage), [record]);
});
