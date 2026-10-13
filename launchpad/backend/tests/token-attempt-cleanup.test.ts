import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenAttemptCleanupService, type AttemptStore } from '../src/services/tokenAttemptCleanup';

class MemoryAttemptStore implements AttemptStore {
  readonly values = new Map<string, string>();
  readonly due = new Map<string, number>();

  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); return 'OK'; }
  async del(key: string) { return this.values.delete(key) ? 1 : 0; }
  async zadd(_key: string, score: number, member: string) { this.due.set(member, score); return 1; }
  async zrem(_key: string, ...members: string[]) {
    let removed = 0;
    for (const member of members) if (this.due.delete(member)) removed += 1;
    return removed;
  }
  async zrangebyscore(_key: string, min: number, max: number, _limit: 'LIMIT', offset: number, count: number) {
    return [...this.due.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((left, right) => left[1] - right[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }
}

test('cancelled token attempt unpins only unreferenced CIDs owned by that attempt', async () => {
  const store = new MemoryAttemptStore();
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async (cid) => cid === 'shared-image-cid',
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => 1000,
  });

  await service.begin('attempt-1', 'wallet-1');
  await service.addCid('attempt-1', 'wallet-1', 'orphan-image-cid');
  await service.addCid('attempt-1', 'wallet-1', 'shared-image-cid');
  await service.setMintAddress('attempt-1', 'wallet-1', 'mint-1');

  assert.equal(await service.cancel('attempt-1', 'wallet-1', 'mint-1'), true);
  assert.deepEqual(unpinned, ['orphan-image-cid']);
  assert.equal(await store.get('wire:token-attempt:attempt-1'), null);
});

test('token attempt cannot be cancelled by another wallet or for another mint', async () => {
  const store = new MemoryAttemptStore();
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => 1000,
  });
  await service.begin('attempt-2', 'wallet-1');
  await service.addCid('attempt-2', 'wallet-1', 'orphan-cid');
  await service.setMintAddress('attempt-2', 'wallet-1', 'mint-1');

  assert.equal(await service.cancel('attempt-2', 'wallet-2', 'mint-1'), false);
  assert.equal(await service.cancel('attempt-2', 'wallet-1', 'mint-2'), false);
  assert.deepEqual(unpinned, []);
});

test('expiry sweep preserves a submitted attempt whose transaction is confirmed', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore();
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'confirmed',
    now: () => now,
  });
  await service.begin('attempt-3', 'wallet-1');
  await service.addCid('attempt-3', 'wallet-1', 'token-metadata-cid');
  await service.markSubmitted('attempt-3', 'wallet-1', 'signature-1');
  now += 24 * 60 * 60 * 1000;

  assert.deepEqual(await service.sweepExpired(), { cleaned: 0, preserved: 1, deferred: 0 });
  assert.deepEqual(unpinned, []);
  assert.equal(await store.get('wire:token-attempt:attempt-3'), null);
});

test('expiry sweep cleans an abandoned attempt after its safety window', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore();
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });
  await service.begin('attempt-4', 'wallet-1');
  await service.addCid('attempt-4', 'wallet-1', 'abandoned-cid');
  now += 24 * 60 * 60 * 1000;

  assert.deepEqual(await service.sweepExpired(), { cleaned: 1, preserved: 0, deferred: 0 });
  assert.deepEqual(unpinned, ['abandoned-cid']);
  assert.equal(await store.get('wire:token-attempt:attempt-4'), null);
});
