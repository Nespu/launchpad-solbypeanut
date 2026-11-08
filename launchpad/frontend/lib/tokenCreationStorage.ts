const TOKEN_CREATION_STORAGE_PREFIX = 'wire:token-creation:v1:';
const POOL_POSITION_STORAGE_PREFIX = 'wire:pool-position:v1:';

export function tokenCreationStorageKey(walletAddress: string) {
  return `${TOKEN_CREATION_STORAGE_PREFIX}${walletAddress}`;
}

function poolPositionStorageKey(walletAddress: string, poolAddress: string) {
  return `${POOL_POSITION_STORAGE_PREFIX}${walletAddress}:${poolAddress}`;
}

export function hasStoredFullPoolWithdrawal(walletAddress: string, poolAddress: string) {
  try {
    return window.localStorage.getItem(poolPositionStorageKey(walletAddress, poolAddress)) === 'withdrawn';
  } catch {
    return false;
  }
}

export function clearStoredFullPoolWithdrawal(walletAddress: string, poolAddress: string) {
  try {
    window.localStorage.removeItem(poolPositionStorageKey(walletAddress, poolAddress));
  } catch {
    // The chain balance remains authoritative when local storage is unavailable.
  }
}

export function markStoredTokenCreationPoolWithdrawn(walletAddress: string, poolAddress: string) {
  let updated = false;
  try {
    window.localStorage.setItem(poolPositionStorageKey(walletAddress, poolAddress), 'withdrawn');
    updated = true;
  } catch {
    // The confirmed transaction is still reflected in the withdrawal history.
  }

  try {
    const key = tokenCreationStorageKey(walletAddress);
    const raw = window.localStorage.getItem(key);
    if (!raw) return updated;
    const saved = JSON.parse(raw) as { createdPool?: { poolId?: unknown; txId?: unknown } | null; poolStatus?: string };
    if (saved.createdPool?.poolId !== poolAddress) return updated;
    // Keep the token/pool history. A full withdrawal closes the wallet's
    // current LP position; it does not delete the on-chain pool.
    window.localStorage.setItem(key, JSON.stringify({ ...saved, poolStatus: 'withdrawn', summaryDismissed: true }));
    window.dispatchEvent(new Event('wire:token-creation-updated'));
    return true;
  } catch {
    return updated;
  }
}

export function markStoredPoolWithoutLp(walletAddress: string, poolAddress: string) {
  try {
    const key = tokenCreationStorageKey(walletAddress);
    const raw = window.localStorage.getItem(key);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { createdPool?: { poolId?: unknown } | null; poolStatus?: string };
    if (saved.createdPool?.poolId !== poolAddress) return false;
    if (saved.poolStatus !== 'withdrawn') {
      window.localStorage.setItem(key, JSON.stringify({ ...saved, poolStatus: 'no-position' }));
    }
    return true;
  } catch {
    return false;
  }
}
