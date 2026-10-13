export type TokenAttemptRecord = {
  attemptId: string;
  userWallet: string;
  mintAddress?: string;
  txHash?: string;
  cids: string[];
  createdAt: number;
};

export type AttemptStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zrangebyscore(key: string, min: number, max: number, limitToken: 'LIMIT', offset: number, count: number): Promise<string[]>;
};

export type AttemptCleanupDependencies = {
  isCidReferenced(cid: string): Promise<boolean>;
  unpin(cid: string): Promise<void>;
  getSignatureState(signature: string): Promise<'confirmed' | 'failed' | 'pending' | 'missing'>;
  onCleanupError?(attemptId: string, error: unknown): void;
  now?: () => number;
};

const RECORD_PREFIX = 'wire:token-attempt:';
const EXPIRY_INDEX = 'wire:token-attempt:cleanup';
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 25;

function parseRecord(raw: string | null): TokenAttemptRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TokenAttemptRecord;
    if (
      typeof parsed.attemptId !== 'string' ||
      typeof parsed.userWallet !== 'string' ||
      !Array.isArray(parsed.cids) ||
      !parsed.cids.every((cid) => typeof cid === 'string') ||
      typeof parsed.createdAt !== 'number'
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createTokenAttemptCleanupService(
  store: AttemptStore,
  dependencies: AttemptCleanupDependencies,
) {
  const now = dependencies.now ?? Date.now;
  let sweepTimer: NodeJS.Timeout | undefined;
  let sweeping = false;

  async function getRecord(attemptId: string): Promise<TokenAttemptRecord | null> {
    return parseRecord(await store.get(`${RECORD_PREFIX}${attemptId}`));
  }

  async function saveRecord(record: TokenAttemptRecord): Promise<void> {
    await store.set(`${RECORD_PREFIX}${record.attemptId}`, JSON.stringify(record));
    await store.zadd(EXPIRY_INDEX, record.createdAt + CLEANUP_AFTER_MS, record.attemptId);
  }

  async function removeRecord(attemptId: string): Promise<void> {
    await Promise.all([
      store.del(`${RECORD_PREFIX}${attemptId}`),
      store.zrem(EXPIRY_INDEX, attemptId),
    ]);
  }

  async function defer(record: TokenAttemptRecord): Promise<void> {
    await store.zadd(EXPIRY_INDEX, now() + RETRY_AFTER_MS, record.attemptId);
  }

  async function cleanRecord(record: TokenAttemptRecord): Promise<'cleaned' | 'preserved' | 'deferred'> {
    if (record.txHash) {
      const signatureState = await dependencies.getSignatureState(record.txHash);
      if (signatureState === 'confirmed') {
        await removeRecord(record.attemptId);
        return 'preserved';
      }
      if (signatureState === 'pending') {
        await defer(record);
        return 'deferred';
      }
    }

    for (const cid of new Set(record.cids)) {
      if (await dependencies.isCidReferenced(cid)) continue;
      await dependencies.unpin(cid);
    }
    await removeRecord(record.attemptId);
    return 'cleaned';
  }

  return {
    async begin(attemptId: string, userWallet: string): Promise<void> {
      const key = `${RECORD_PREFIX}${attemptId}`;
      if (await store.get(key)) throw new Error('Token creation attempt already exists');
      await saveRecord({ attemptId, userWallet, cids: [], createdAt: now() });
    },

    async addCid(attemptId: string, userWallet: string, cid: string): Promise<void> {
      const record = await getRecord(attemptId);
      if (!record || record.userWallet !== userWallet) throw new Error('Token creation attempt not found');
      if (!record.cids.includes(cid)) record.cids.push(cid);
      await saveRecord(record);
    },

    async cleanupKnownCids(cids: string[]): Promise<void> {
      for (const cid of new Set(cids)) {
        if (await dependencies.isCidReferenced(cid)) continue;
        await dependencies.unpin(cid);
      }
    },

    async setMintAddress(attemptId: string, userWallet: string, mintAddress: string): Promise<void> {
      const record = await getRecord(attemptId);
      if (!record || record.userWallet !== userWallet) throw new Error('Token creation attempt not found');
      record.mintAddress = mintAddress;
      await saveRecord(record);
    },

    async markSubmitted(attemptId: string | undefined, userWallet: string, txHash: string): Promise<void> {
      if (!attemptId) return;
      const record = await getRecord(attemptId);
      // Older browser tabs or a lost Redis record must not block registering a
      // transaction that has already been signed; it simply cannot be swept.
      if (!record) return;
      if (record.userWallet !== userWallet) throw new Error('Token creation attempt not found');
      record.txHash = txHash;
      await saveRecord(record);
    },

    async complete(attemptId: string | undefined, userWallet: string): Promise<void> {
      if (!attemptId) return;
      const record = await getRecord(attemptId);
      if (!record || record.userWallet !== userWallet) return;
      await removeRecord(attemptId);
    },

    async cancel(attemptId: string, userWallet: string, mintAddress?: string): Promise<boolean> {
      const record = await getRecord(attemptId);
      if (!record || record.userWallet !== userWallet) return false;
      if (record.mintAddress && mintAddress && record.mintAddress !== mintAddress) return false;
      // A cancellation report must never unpin files after a signed transaction
      // has been submitted; the sweeper checks its on-chain status instead.
      if (record.txHash) return false;
      try {
        await cleanRecord(record);
      } catch (error) {
        await defer(record);
        throw error;
      }
      return true;
    },

    async sweepExpired(): Promise<{ cleaned: number; preserved: number; deferred: number }> {
      if (sweeping) return { cleaned: 0, preserved: 0, deferred: 0 };
      sweeping = true;
      const counts = { cleaned: 0, preserved: 0, deferred: 0 };
      try {
        const due = await store.zrangebyscore(EXPIRY_INDEX, 0, now(), 'LIMIT', 0, SWEEP_BATCH_SIZE);
        for (const attemptId of due) {
          try {
            const record = await getRecord(attemptId);
            if (!record) {
              await store.zrem(EXPIRY_INDEX, attemptId);
              continue;
            }
            const result = await cleanRecord(record);
            counts[result] += 1;
          } catch (error) {
            dependencies.onCleanupError?.(attemptId, error);
            const record = await getRecord(attemptId);
            if (record) await defer(record);
            counts.deferred += 1;
          }
        }
        return counts;
      } finally {
        sweeping = false;
      }
    },

    start(onError: (error: unknown) => void = () => undefined): void {
      if (sweepTimer) return;
      sweepTimer = setInterval(() => {
        void this.sweepExpired().catch(onError);
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref();
      void this.sweepExpired().catch(onError);
    },

    stop(): void {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
    },
  };
}
