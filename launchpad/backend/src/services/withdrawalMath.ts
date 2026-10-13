export interface WithdrawalMathInput {
  lpAmountRaw: string;
  lpSupplyRaw: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  solIsBase: boolean;
}

export interface WithdrawalMathResult {
  totalSolOutLamports: bigint;
  userAmountLamports: bigint;
  platformFeeLamports: bigint;
  baseMinAmountRaw: bigint;
  quoteMinAmountRaw: bigint;
  totalSolOut: number;
  userAmountSol: number;
  platformFeeSol: number;
}

const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;
const UINT_PATTERN = /^(0|[1-9]\d*)$/;

function parseRawAmount(value: string, label: string): bigint {
  if (!UINT_PATTERN.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function proportionalAmount(reserve: bigint, lpAmount: bigint, lpSupply: bigint): bigint {
  return (reserve * lpAmount) / lpSupply;
}

function minAfterOnePercentSlippage(amount: bigint): bigint {
  return (amount * 99n) / 100n;
}

function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL_BIGINT);
}

export function calculateWithdrawalAmounts(input: WithdrawalMathInput): WithdrawalMathResult {
  const lpAmount = parseRawAmount(input.lpAmountRaw, 'LP amount');
  const lpSupply = parseRawAmount(input.lpSupplyRaw, 'LP supply');
  const baseReserve = parseRawAmount(input.baseReserveRaw, 'Base reserve');
  const quoteReserve = parseRawAmount(input.quoteReserveRaw, 'Quote reserve');

  if (lpAmount <= 0n || lpSupply <= 0n) {
    throw new Error('LP amount and pool supply must be greater than zero');
  }
  if (lpAmount > lpSupply) {
    throw new Error('LP amount cannot exceed the pool supply');
  }

  // Preserve the service's existing order: floor proportional output first,
  // then floor the 1% slippage-adjusted minimum for each side.
  const baseAmount = proportionalAmount(baseReserve, lpAmount, lpSupply);
  const quoteAmount = proportionalAmount(quoteReserve, lpAmount, lpSupply);
  const totalSolOutLamports = input.solIsBase ? baseAmount : quoteAmount;
  const platformFeeLamports = (totalSolOutLamports * 10n) / 100n;
  if (platformFeeLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Platform fee exceeds the safe lamport range');
  }
  const userAmountLamports = totalSolOutLamports - platformFeeLamports;

  return {
    totalSolOutLamports,
    userAmountLamports,
    platformFeeLamports,
    baseMinAmountRaw: minAfterOnePercentSlippage(baseAmount),
    quoteMinAmountRaw: minAfterOnePercentSlippage(quoteAmount),
    totalSolOut: lamportsToSol(totalSolOutLamports),
    userAmountSol: lamportsToSol(userAmountLamports),
    platformFeeSol: lamportsToSol(platformFeeLamports),
  };
}
