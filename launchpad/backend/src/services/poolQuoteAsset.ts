export const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
export const DEVNET_USDC_MINT_ADDRESS = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export type QuoteAsset = 'SOL' | 'USDC';

export const QUOTE_ASSETS: Record<QuoteAsset, { mintAddress: string; symbol: QuoteAsset; decimals: number }> = {
  SOL: { mintAddress: SOL_MINT_ADDRESS, symbol: 'SOL', decimals: 9 },
  USDC: { mintAddress: DEVNET_USDC_MINT_ADDRESS, symbol: 'USDC', decimals: 6 },
};

export function parseQuoteAsset(value: string | undefined): QuoteAsset {
  if (value === undefined || value === 'SOL') return 'SOL';
  if (value === 'USDC') return 'USDC';
  throw new Error('Unsupported pool quote asset.');
}

export function parseDecimalToRaw(value: string, decimals: number): bigint {
  const match = /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(value);
  if (!match) throw new Error('Quote amount must be a decimal number.');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`Quote amount supports up to ${decimals} decimal places.`);
  const raw = BigInt(match[1]) * 10n ** BigInt(decimals)
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n) throw new Error('Quote amount must be greater than zero.');
  return raw;
}

export function formatRawAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
