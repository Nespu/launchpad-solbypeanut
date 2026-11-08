import { PublicKey } from '@solana/web3.js';

const MAX_PROJECT_BUY_WALLETS = 10;
const SOL_DECIMALS = 9;
const SOL_SCALE = 10n ** BigInt(SOL_DECIMALS);
const VALID_SOL_AMOUNT = /^\d{1,20}(?:\.\d{1,9})?$/;

function parseSolLamports(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SOL_SCALE + BigInt(fraction.padEnd(SOL_DECIMALS, '0'));
}

function formatSolLamports(value: bigint) {
  const whole = value / SOL_SCALE;
  const fraction = (value % SOL_SCALE).toString().padStart(SOL_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function applyEqualProjectWalletBuyAmount(walletAddresses: string[], amount: string) {
  const normalizedAmount = amount.trim();
  if (!VALID_SOL_AMOUNT.test(normalizedAmount) || !/[1-9]/.test(normalizedAmount)) {
    throw new RangeError('A positive SOL amount with at most nine decimal places is required.');
  }
  if (walletAddresses.length < 1 || walletAddresses.length > MAX_PROJECT_BUY_WALLETS
    || new Set(walletAddresses).size !== walletAddresses.length
    || walletAddresses.some((address) => {
      try { return new PublicKey(address).toBase58() !== address; } catch { return true; }
    })) {
    throw new RangeError('Select between one and ten distinct project wallets.');
  }
  return Object.fromEntries(walletAddresses.map((address) => [address, normalizedAmount]));
}

export function sumProjectWalletBuyAmounts(walletAddresses: string[], amounts: Record<string, string>) {
  const total = walletAddresses.reduce((sum, address) => {
    const amount = amounts[address]?.trim() ?? '';
    if (!VALID_SOL_AMOUNT.test(amount) || !/[1-9]/.test(amount)) return sum;
    return sum + parseSolLamports(amount);
  }, 0n);
  return formatSolLamports(total);
}
