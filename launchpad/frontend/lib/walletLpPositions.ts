import { PublicKey } from '@solana/web3.js';

export type TrackedRaydiumPool = {
  poolAddress: string | null;
  mintAddress: string;
  quoteMint: string;
  symbol: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
};

export type WalletLpUnderlyingAsset = {
  mintAddress: string;
  symbol: string;
  decimals: number;
  reserveRaw: string;
  amountRaw: string;
};

export type WalletLpUnderlyingEstimate = {
  lpMint: string;
  lpAmountRaw: string;
  lpSupplyRaw: string;
  poolKind: 'cpmm' | 'amm-v4';
  assets: [WalletLpUnderlyingAsset, WalletLpUnderlyingAsset];
};

export type WalletLpPosition = {
  lpMint: string;
  rawBalance: string;
  decimals: number;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  positionEstimate: WalletLpUnderlyingEstimate | null;
  positionEstimateStatus: 'ready' | 'unavailable' | 'zero-balance' | 'not-requested';
};

export type ResolvedRaydiumLpPool = {
  lpMint: string;
  poolAddress: string;
  poolProgramId: string;
  quoteMint: string;
  tokenMint: string;
  tokenSymbol: string;
};

export type WalletLpPositionScan = {
  positionsByMint: Map<string, WalletLpPosition>;
  trackedPoolsByMint: Map<string, ResolvedRaydiumLpPool>;
  poolsChecked: number;
  poolsFailed: number;
};

function canonicalAddress(value: string): string | null {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function parsePositionEstimate(value: unknown, lpMint: string, lpAmountRaw: string): WalletLpUnderlyingEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const estimateLpMint = typeof data.lpMint === 'string' ? canonicalAddress(data.lpMint) : null;
  if (estimateLpMint !== lpMint
    || data.lpAmountRaw !== lpAmountRaw
    || typeof data.lpSupplyRaw !== 'string' || !/^\d+$/.test(data.lpSupplyRaw)
    || BigInt(data.lpSupplyRaw) <= 0n
    || BigInt(data.lpAmountRaw as string) > BigInt(data.lpSupplyRaw)
    || (data.poolKind !== 'cpmm' && data.poolKind !== 'amm-v4')
    || !Array.isArray(data.assets) || data.assets.length !== 2) return null;

  const assets: WalletLpUnderlyingAsset[] = [];
  for (const assetValue of data.assets) {
    if (!assetValue || typeof assetValue !== 'object') return null;
    const asset = assetValue as Record<string, unknown>;
    const mintAddress = typeof asset.mintAddress === 'string' ? canonicalAddress(asset.mintAddress) : null;
    if (!mintAddress || typeof asset.symbol !== 'string' || !asset.symbol.trim()
      || !Number.isInteger(asset.decimals) || (asset.decimals as number) < 0 || (asset.decimals as number) > 18
      || typeof asset.reserveRaw !== 'string' || !/^\d+$/.test(asset.reserveRaw)
      || typeof asset.amountRaw !== 'string' || !/^\d+$/.test(asset.amountRaw)
      || BigInt(asset.amountRaw) > BigInt(asset.reserveRaw)
      || BigInt(asset.amountRaw) !== (BigInt(asset.reserveRaw) * BigInt(lpAmountRaw)) / BigInt(data.lpSupplyRaw)) return null;
    assets.push({
      mintAddress,
      symbol: asset.symbol.trim(),
      decimals: asset.decimals as number,
      reserveRaw: asset.reserveRaw,
      amountRaw: asset.amountRaw,
    });
  }
  if (assets[0].mintAddress === assets[1].mintAddress) return null;

  return {
    lpMint,
    lpAmountRaw,
    lpSupplyRaw: data.lpSupplyRaw,
    poolKind: data.poolKind,
    assets: [assets[0], assets[1]],
  };
}

export async function scanTrackedRaydiumLpPositions(input: {
  walletAddress: string;
  apiBase: string;
  pools: TrackedRaydiumPool[];
  fetcher?: typeof fetch;
  concurrency?: number;
}): Promise<WalletLpPositionScan> {
  const walletAddress = canonicalAddress(input.walletAddress);
  if (!walletAddress) throw new Error('Wallet address is invalid.');

  const uniquePools = new Map<string, TrackedRaydiumPool>();
  let poolsFailed = 0;
  for (const pool of input.pools) {
    if (pool.launchPlatform !== 'RAYDIUM' || !pool.poolAddress) continue;
    const poolAddress = canonicalAddress(pool.poolAddress);
    if (!poolAddress) {
      poolsFailed += 1;
      continue;
    }
    if (!uniquePools.has(poolAddress)) uniquePools.set(poolAddress, { ...pool, poolAddress });
  }

  const pools = [...uniquePools.values()];
  const positionsByMint = new Map<string, WalletLpPosition>();
  const trackedPoolsByMint = new Map<string, ResolvedRaydiumLpPool>();
  const ambiguousMints = new Set<string>();
  const fetcher = input.fetcher ?? fetch;
  let nextPoolIndex = 0;
  const workerCount = Math.min(pools.length, Math.max(1, Math.floor(input.concurrency ?? 4)));

  const worker = async () => {
    while (true) {
      const pool = pools[nextPoolIndex];
      nextPoolIndex += 1;
      if (!pool?.poolAddress) return;

      try {
        const params = new URLSearchParams({ userWallet: walletAddress, poolAddress: pool.poolAddress, includePosition: 'true' });
        const response = await fetcher(`${input.apiBase}/api/lp-balance?${params.toString()}`, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await response.json().catch(() => null) as {
          success?: unknown;
          lpMint?: unknown;
          poolProgramId?: unknown;
          rawBalance?: unknown;
          decimals?: unknown;
          positionEstimate?: unknown;
          positionEstimateStatus?: unknown;
        } | null;
        if (!response.ok || data?.success !== true
          || typeof data.lpMint !== 'string' || typeof data.rawBalance !== 'string'
          || typeof data.poolProgramId !== 'string'
          || !/^\d+$/.test(data.rawBalance)
          || !Number.isInteger(data.decimals) || (data.decimals as number) < 0 || (data.decimals as number) > 18) {
          throw new Error('LP balance response is invalid.');
        }
        const lpMint = canonicalAddress(data.lpMint);
        const poolProgramId = canonicalAddress(data.poolProgramId);
        const tokenMint = canonicalAddress(pool.mintAddress);
        const quoteMint = canonicalAddress(pool.quoteMint);
        if (!lpMint || !poolProgramId || !tokenMint || !quoteMint) throw new Error('LP balance response contains an invalid address.');
        const trackedPool: ResolvedRaydiumLpPool = {
          lpMint,
          poolAddress: pool.poolAddress,
          poolProgramId,
          quoteMint,
          tokenMint,
          tokenSymbol: pool.symbol,
        };
        const existingTrackedPool = trackedPoolsByMint.get(lpMint);
        if (ambiguousMints.has(lpMint)) continue;
        if (existingTrackedPool && existingTrackedPool.poolAddress !== pool.poolAddress) {
          trackedPoolsByMint.delete(lpMint);
          positionsByMint.delete(lpMint);
          ambiguousMints.add(lpMint);
          poolsFailed += 1;
          continue;
        }
        trackedPoolsByMint.set(lpMint, trackedPool);
        if (data.rawBalance === '0') continue;
        const positionEstimate = data.positionEstimateStatus === 'ready'
          ? parsePositionEstimate(data.positionEstimate, lpMint, data.rawBalance)
          : null;
        const positionEstimateStatus = data.positionEstimateStatus === 'zero-balance'
          ? 'zero-balance'
          : data.positionEstimateStatus === 'not-requested'
            ? 'not-requested'
            : positionEstimate
              ? 'ready'
              : 'unavailable';

        const position: WalletLpPosition = {
          lpMint,
          rawBalance: data.rawBalance,
          decimals: data.decimals as number,
          poolAddress: pool.poolAddress,
          tokenMint,
          tokenSymbol: pool.symbol,
          positionEstimate,
          positionEstimateStatus,
        };
        const existing = positionsByMint.get(lpMint);
        if (existing && existing.poolAddress !== pool.poolAddress) {
          positionsByMint.delete(lpMint);
          trackedPoolsByMint.delete(lpMint);
          ambiguousMints.add(lpMint);
          poolsFailed += 1;
          continue;
        }
        positionsByMint.set(lpMint, position);
      } catch {
        poolsFailed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { positionsByMint, trackedPoolsByMint, poolsChecked: pools.length, poolsFailed };
}

function publicKeyString(value: unknown): string | null {
  if (typeof value === 'string') return canonicalAddress(value);
  if (!value || typeof value !== 'object') return null;
  const toBase58 = (value as { toBase58?: unknown }).toBase58;
  if (typeof toBase58 !== 'function') return null;
  try {
    const address = toBase58.call(value);
    return typeof address === 'string' ? canonicalAddress(address) : null;
  } catch {
    return null;
  }
}

function getTransactionProgramIds(transaction: unknown): Set<string> {
  if (!transaction || typeof transaction !== 'object') return new Set();
  const root = transaction as {
    transaction?: { message?: { instructions?: unknown } };
    meta?: { innerInstructions?: unknown };
  };
  const instructions: unknown[] = [];
  if (Array.isArray(root.transaction?.message?.instructions)) instructions.push(...root.transaction.message.instructions);
  if (Array.isArray(root.meta?.innerInstructions)) {
    for (const group of root.meta.innerInstructions) {
      if (group && typeof group === 'object' && Array.isArray((group as { instructions?: unknown }).instructions)) {
        instructions.push(...(group as { instructions: unknown[] }).instructions);
      }
    }
  }
  return new Set(instructions.flatMap((instruction) => {
    if (!instruction || typeof instruction !== 'object') return [];
    const programId = publicKeyString((instruction as { programId?: unknown }).programId);
    return programId ? [programId] : [];
  }));
}

export function getTrackedRaydiumPoolAddressesInTransaction(transaction: unknown, pools: TrackedRaydiumPool[]): string[] {
  if (!transaction || typeof transaction !== 'object') return [];
  const message = (transaction as { transaction?: { message?: { accountKeys?: unknown } } }).transaction?.message;
  if (!Array.isArray(message?.accountKeys)) return [];
  const accountKeys = new Set(message.accountKeys.flatMap((entry) => {
    const key = entry && typeof entry === 'object' && 'pubkey' in entry
      ? publicKeyString((entry as { pubkey?: unknown }).pubkey)
      : publicKeyString(entry);
    return key ? [key] : [];
  }));
  return pools.flatMap((pool) => {
    const poolAddress = pool.poolAddress ? canonicalAddress(pool.poolAddress) : null;
    return poolAddress && accountKeys.has(poolAddress) ? [poolAddress] : [];
  });
}

export function matchTrackedRaydiumLpMovements(input: {
  transaction: unknown;
  tokenDeltas: Array<{ mintAddress: string; decimals: number | null; amountRaw: string }>;
  pools: ResolvedRaydiumLpPool[];
}): ResolvedRaydiumLpPool[] {
  const mentionedPoolAddresses = new Set(getTrackedRaydiumPoolAddressesInTransaction(
    input.transaction,
    input.pools.map((pool) => ({
      poolAddress: pool.poolAddress,
      mintAddress: pool.tokenMint,
      quoteMint: pool.quoteMint,
      symbol: pool.tokenSymbol,
      launchPlatform: 'RAYDIUM' as const,
    })),
  ));
  if (mentionedPoolAddresses.size !== 1) return [];
  const mentionedPoolAddress = [...mentionedPoolAddresses][0];
  const candidates = input.pools.filter((pool) => pool.poolAddress === mentionedPoolAddress);
  if (candidates.length !== 1) return [];
  const pool = candidates[0];
  if (!pool || !getTransactionProgramIds(input.transaction).has(pool.poolProgramId)) return [];
  const deltasByMint = new Map(input.tokenDeltas.map((delta) => [delta.mintAddress, delta.amountRaw]));
  const lpDelta = deltasByMint.get(pool.lpMint);
  const hasUnderlyingDelta = [pool.tokenMint, pool.quoteMint].some((mintAddress) => {
    const amountRaw = deltasByMint.get(mintAddress);
    return typeof amountRaw === 'string' && /^-?\d+$/.test(amountRaw) && BigInt(amountRaw) !== 0n;
  });
  const onlyPoolAssetsChanged = input.tokenDeltas.every((delta) =>
    delta.mintAddress === pool.lpMint || delta.mintAddress === pool.tokenMint || delta.mintAddress === pool.quoteMint,
  );
  const deltasAreValid = input.tokenDeltas.every((delta) => delta.decimals !== null
    && Number.isInteger(delta.decimals) && delta.decimals >= 0 && delta.decimals <= 18
    && /^-?\d+$/.test(delta.amountRaw) && BigInt(delta.amountRaw) !== 0n);
  if (!onlyPoolAssetsChanged || !hasUnderlyingDelta || !deltasAreValid
    || typeof lpDelta !== 'string' || !/^-?\d+$/.test(lpDelta) || BigInt(lpDelta) === 0n) return [];
  return [pool];
}
