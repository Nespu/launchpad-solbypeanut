export const MARKET_LAUNCH_TRIGGER_TTL_MS = 15 * 60 * 1000;
export const MARKET_LAUNCH_TRIGGER_POLL_INTERVAL_MS = 5_000;
export const MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS = 20_000_000n;
export const MARKET_LAUNCH_ACCOUNT_RESERVE_LAMPORTS = 10_000_000n;

export type MarketLaunchPlan = {
  mintAddress: string;
  quoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  side: 'buy' | 'sell';
  selected: readonly string[];
  amounts: Readonly<Record<string, string>>;
  maxTotalSpend: string;
  slippageBps: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  maxConsecutiveErrors: number;
};

export function marketLaunchPlanFingerprint(plan: MarketLaunchPlan): string {
  return JSON.stringify({
    mintAddress: plan.mintAddress,
    quoteMint: plan.quoteMint,
    launchPlatform: plan.launchPlatform,
    side: plan.side,
    selected: plan.selected.map((address) => [address, plan.amounts[address] ?? '']),
    maxTotalSpend: plan.maxTotalSpend.trim(),
    slippageBps: plan.slippageBps,
    delayMinSeconds: plan.delayMinSeconds,
    delayMaxSeconds: plan.delayMaxSeconds,
    maxConsecutiveErrors: plan.maxConsecutiveErrors,
  });
}

export function isMarketLaunchTriggerExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt === null || !Number.isFinite(expiresAt) || expiresAt <= now;
}

export function isMarketLaunchFeeReserveWithinCap(networkFeesLamports: readonly string[]): boolean {
  if (!networkFeesLamports.length) return false;
  return networkFeesLamports.every((fee) => {
    if (!/^\d+$/.test(fee)) return false;
    return BigInt(fee) + MARKET_LAUNCH_ACCOUNT_RESERVE_LAMPORTS
      <= MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS;
  });
}
