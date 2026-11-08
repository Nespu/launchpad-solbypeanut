export interface WithdrawalMathInput {
  lpAmountRaw: string;
  lpSupplyRaw: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  quoteIsBase?: boolean;
  /** @deprecated Use quoteIsBase; retained for older internal callers. */
  solIsBase?: boolean;
  quoteDecimals?: number;
}

export interface WithdrawalMathResult {
  totalQuoteOutRaw: bigint;
  userAmountRaw: bigint;
  platformFeeRaw: bigint;
  quoteDecimals: number;
  totalQuoteOut: number;
  userAmount: number;
  platformFee: number;
  totalSolOutLamports: bigint;
  userAmountLamports: bigint;
  platformFeeLamports: bigint;
  baseMinAmountRaw: bigint;
  quoteMinAmountRaw: bigint;
  totalSolOut: number;
  userAmountSol: number;
  platformFeeSol: number;
}

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
  const quoteIsBase = input.quoteIsBase ?? input.solIsBase;
  if (quoteIsBase === undefined) throw new Error('The quote asset reserve side is required');
  const totalQuoteOutRaw = quoteIsBase ? baseAmount : quoteAmount;
  const platformFeeRaw = (totalQuoteOutRaw * 10n) / 100n;
  const userAmountRaw = totalQuoteOutRaw - platformFeeRaw;
  const quoteDecimals = input.quoteDecimals ?? 9;
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) {
    throw new Error('Quote token decimals are not supported');
  }
  const divisor = 10 ** quoteDecimals;
  const totalQuoteOut = Number(totalQuoteOutRaw) / divisor;
  const userAmount = Number(userAmountRaw) / divisor;
  const platformFee = Number(platformFeeRaw) / divisor;

  return {
    totalQuoteOutRaw,
    userAmountRaw,
    platformFeeRaw,
    quoteDecimals,
    totalQuoteOut,
    userAmount,
    platformFee,
    totalSolOutLamports: totalQuoteOutRaw,
    userAmountLamports: userAmountRaw,
    platformFeeLamports: platformFeeRaw,
    baseMinAmountRaw: minAfterOnePercentSlippage(baseAmount),
    quoteMinAmountRaw: minAfterOnePercentSlippage(quoteAmount),
    totalSolOut: totalQuoteOut,
    userAmountSol: userAmount,
    platformFeeSol: platformFee,
  };
}
