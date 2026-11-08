export type TokenSellAlertContext = {
  mintAddress: string;
  quoteMint: string;
  tokenDecimals: number;
  quoteDecimals: number;
};

export type TokenSellAlert = {
  amountIn: string;
  minimumAmountOut: string;
  status: 'armed' | 'triggered';
  triggeredAt?: number;
};

const STORAGE_PREFIX = 'wire:token-sell-alert:v1:';
const MAX_AMOUNT_LENGTH = 40;

export function tokenSellAlertStorageKey(context: Pick<TokenSellAlertContext, 'mintAddress' | 'quoteMint'>): string {
  return STORAGE_PREFIX + context.mintAddress + ':' + context.quoteMint;
}

function validDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 18;
}

export function isPositiveDecimalAmount(value: unknown, decimals: number): value is string {
  if (typeof value !== 'string' || value.length > MAX_AMOUNT_LENGTH || !validDecimals(decimals)) return false;
  const fraction = decimals > 0 ? '(?:\\.\\d{1,' + decimals + '})?' : '';
  return new RegExp('^\\d{1,20}' + fraction + '$').test(value.trim()) && /[1-9]/.test(value);
}

function toRawAmount(value: string, decimals: number): bigint | null {
  if (!isPositiveDecimalAmount(value, decimals)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function shouldTriggerTokenSellAlert(amountOut: string, minimumAmountOut: string, quoteDecimals: number): boolean {
  const actual = toRawAmount(amountOut, quoteDecimals);
  const target = toRawAmount(minimumAmountOut, quoteDecimals);
  return actual !== null && target !== null && actual >= target;
}

export function serializeTokenSellAlert(alert: TokenSellAlert, context: TokenSellAlertContext): string | null {
  if (!context.mintAddress || !context.quoteMint
    || !isPositiveDecimalAmount(alert.amountIn, context.tokenDecimals)
    || !isPositiveDecimalAmount(alert.minimumAmountOut, context.quoteDecimals)
    || (alert.status !== 'armed' && alert.status !== 'triggered')
    || (alert.status === 'triggered' && (!Number.isSafeInteger(alert.triggeredAt) || (alert.triggeredAt ?? 0) <= 0))
    || (alert.status === 'armed' && alert.triggeredAt !== undefined)) return null;
  return JSON.stringify({
    version: 1,
    mintAddress: context.mintAddress,
    quoteMint: context.quoteMint,
    amountIn: alert.amountIn.trim(),
    minimumAmountOut: alert.minimumAmountOut.trim(),
    status: alert.status,
    ...(alert.status === 'triggered' ? { triggeredAt: alert.triggeredAt } : {}),
  });
}

export function parseTokenSellAlert(raw: string | null, context: TokenSellAlertContext): TokenSellAlert | null {
  if (!raw || raw.length > 2048 || !context.mintAddress || !context.quoteMint) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1
      || candidate.mintAddress !== context.mintAddress
      || candidate.quoteMint !== context.quoteMint
      || !isPositiveDecimalAmount(candidate.amountIn, context.tokenDecimals)
      || !isPositiveDecimalAmount(candidate.minimumAmountOut, context.quoteDecimals)
      || (candidate.status !== 'armed' && candidate.status !== 'triggered')) return null;
    if (candidate.status === 'triggered') {
      if (!Number.isSafeInteger(candidate.triggeredAt) || Number(candidate.triggeredAt) <= 0) return null;
      return {
        amountIn: candidate.amountIn.trim(),
        minimumAmountOut: candidate.minimumAmountOut.trim(),
        status: 'triggered',
        triggeredAt: Number(candidate.triggeredAt),
      };
    }
    if (candidate.triggeredAt !== undefined) return null;
    return {
      amountIn: candidate.amountIn.trim(),
      minimumAmountOut: candidate.minimumAmountOut.trim(),
      status: 'armed',
    };
  } catch {
    return null;
  }
}
