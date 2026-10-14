import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenAttemptCleanupService, type AttemptStore } from '../src/services/tokenAttemptCleanup';

class MemoryAttemptStore implements AttemptStore {
  readonly values = new Map<string, string>();
  readonly due = new Map<string, number>();
  readonly sets = new Map<string, Set<string>>();
  readonly setExpiresAt = new Map<string, number>();
  failAtomicCidOperation = false;

  constructor(private readonly now: () => number = Date.now) {}

  private expireSetIfNeeded(key: string) {
    const expiresAt = this.setExpiresAt.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      this.setExpiresAt.delete(key);
      this.sets.delete(key);
    }
  }

  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); return 'OK'; }
  async del(key: string) { return this.values.delete(key) ? 1 : 0; }
  async sadd(key: string, ...members: string[]) {
    this.expireSetIfNeeded(key);
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added += 1;
      set.add(member);
    }
    this.sets.set(key, set);
    return added;
  }
  async scard(key: string) {
    this.expireSetIfNeeded(key);
    return this.sets.get(key)?.size ?? 0;
  }
  async eval(script: string, numberOfKeys: number, ...args: string[]) {
    assert.equal(numberOfKeys, 1);
    if (this.failAtomicCidOperation) throw new Error('simulated Redis CID operation failure');
    const [key, attemptId, ttlSeconds] = args;
    this.expireSetIfNeeded(key);
    const set = this.sets.get(key) ?? new Set<string>();

    if (script.includes("redis.call('SADD'")) {
      const before = set.size;
      set.add(attemptId);
      this.sets.set(key, set);
      this.setExpiresAt.set(key, this.now() + Number(ttlSeconds) * 1000);
      return set.size - before;
    }

    assert.ok(script.includes("redis.call('SREM'"));
    set.delete(attemptId);
    if (set.size === 0) {
      this.sets.delete(key);
      this.setExpiresAt.delete(key);
      return 0;
    }
    this.sets.set(key, set);
    return set.size;
  }
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
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async (cid) => cid === 'shared-image-cid',
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });

  await service.begin('attempt-1', 'wallet-1');
  await service.addCid('attempt-1', 'wallet-1', 'orphan-image-cid');
  await service.addCid('attempt-1', 'wallet-1', 'shared-image-cid');
  await service.setMintAddress('attempt-1', 'wallet-1', 'mint-1');

  assert.equal(await service.cancel('attempt-1', 'wallet-1', 'mint-1'), true);
  assert.deepEqual(unpinned, []);
  now += 2 * 60 * 1000;
  assert.deepEqual(await service.sweepExpired(), { cleaned: 1, preserved: 0, deferred: 0 });
  assert.deepEqual(unpinned, ['orphan-image-cid']);
  assert.equal(await store.get('wire:token-attempt:attempt-1'), null);
});

test('shared CID stays pinned until every cancelled attempt releases its use', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });

  await service.begin('shared-1', 'wallet-1');
  await service.addCid('shared-1', 'wallet-1', 'same-cid');
  await service.begin('shared-2', 'wallet-2');
  await service.addCid('shared-2', 'wallet-2', 'same-cid');

  assert.equal(await service.cancel('shared-1', 'wallet-1'), true);
  now += 2 * 60 * 1000;
  assert.deepEqual(await service.sweepExpired(), { cleaned: 1, preserved: 0, deferred: 0 });
  assert.deepEqual(unpinned, []);

  assert.equal(await service.cancel('shared-2', 'wallet-2'), true);
  now += 2 * 60 * 1000;
  assert.deepEqual(await service.sweepExpired(), { cleaned: 1, preserved: 0, deferred: 0 });
  assert.deepEqual(unpinned, ['same-cid']);
});

test('starting a retry with the same CID during cancellation grace prevents unpin', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });

  await service.begin('retry-1', 'wallet-1');
  await service.addCid('retry-1', 'wallet-1', 'retry-cid');
  assert.equal(await service.cancel('retry-1', 'wallet-1'), true);
  await service.begin('retry-2', 'wallet-1');
  await service.addCid('retry-2', 'wallet-1', 'retry-cid');

  now += 2 * 60 * 1000;
  await service.sweepExpired();
  assert.deepEqual(unpinned, []);
  assert.equal(await store.scard('wire:token-attempt:cid:retry-cid'), 1);
});

test('orphaned CID use expires after its 48-hour TTL and cannot block unpin forever', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });

  await service.begin('orphan-attempt', 'wallet-1');
  await service.addCid('orphan-attempt', 'wallet-1', 'orphan-cid');
  await store.del('wire:token-attempt:orphan-attempt');
  now += 48 * 60 * 60 * 1000;

  await service.cleanupKnownCids(['orphan-cid'], 'orphan-attempt');
  assert.deepEqual(unpinned, ['orphan-cid']);
  assert.equal(await store.scard('wire:token-attempt:cid:orphan-cid'), 0);
});

test('adding another attempt refreshes the shared CID set TTL to 48 hours', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async () => undefined,
    getSignatureState: async () => 'missing',
    now: () => now,
  });

  await service.begin('ttl-1', 'wallet-1');
  await service.addCid('ttl-1', 'wallet-1', 'ttl-cid');
  const firstExpiry = store.setExpiresAt.get('wire:token-attempt:cid:ttl-cid');
  now += 60 * 60 * 1000;
  await service.begin('ttl-2', 'wallet-2');
  await service.addCid('ttl-2', 'wallet-2', 'ttl-cid');

  assert.equal(firstExpiry, 1000 + 48 * 60 * 60 * 1000);
  assert.equal(store.setExpiresAt.get('wire:token-attempt:cid:ttl-cid'), now + 48 * 60 * 60 * 1000);
  assert.equal(await store.scard('wire:token-attempt:cid:ttl-cid'), 2);
});

test('registered token reference blocks unpin after the last attempt is released', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => true,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });

  await service.begin('registered-1', 'wallet-1');
  await service.addCid('registered-1', 'wallet-1', 'registered-cid');
  assert.equal(await service.cancel('registered-1', 'wallet-1'), true);
  now += 2 * 60 * 1000;
  await service.sweepExpired();
  assert.deepEqual(unpinned, []);
});

test('Redis failure defers cleanup without unpinning', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => false,
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });
  await service.begin('redis-failure', 'wallet-1');
  await service.addCid('redis-failure', 'wallet-1', 'redis-cid');
  assert.equal(await service.cancel('redis-failure', 'wallet-1'), true);
  now += 2 * 60 * 1000;
  store.failAtomicCidOperation = true;

  assert.deepEqual(await service.sweepExpired(), { cleaned: 0, preserved: 0, deferred: 1 });
  assert.deepEqual(unpinned, []);
  assert.equal(store.due.get('redis-failure'), now + 5 * 60 * 1000);
});

test('RPC reference-check failure defers cleanup without unpinning', async () => {
  let now = 1000;
  const store = new MemoryAttemptStore(() => now);
  const unpinned: string[] = [];
  const service = createTokenAttemptCleanupService(store, {
    isCidReferenced: async () => { throw new Error('simulated RPC/DB reference-check failure'); },
    unpin: async (cid) => { unpinned.push(cid); },
    getSignatureState: async () => 'missing',
    now: () => now,
  });
  await service.begin('rpc-failure', 'wallet-1');
  await service.addCid('rpc-failure', 'wallet-1', 'rpc-cid');
  assert.equal(await service.cancel('rpc-failure', 'wallet-1'), true);
  now += 2 * 60 * 1000;

  assert.deepEqual(await service.sweepExpired(), { cleaned: 0, preserved: 0, deferred: 1 });
  assert.deepEqual(unpinned, []);
  assert.equal(store.due.get('rpc-failure'), now + 5 * 60 * 1000);
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
