const STORAGE_PREFIX = 'wire:project-wallet-launch-selection:v1:';
const MAX_SELECTION = 10;
const BUY_DELAY_OPTIONS = [0, 2, 5, 10, 30];
const BUY_SLIPPAGE_OPTIONS = [50, 100, 200, 500];

export type ProjectWalletLaunchSelection = {
  walletAddresses: string[];
  buyAmounts: Record<string, string>;
  buyDelaySeconds: number;
  buySlippageBps: number;
};

function storageKey(mintAddress: string) {
  return `${STORAGE_PREFIX}${mintAddress}`;
}

export function queueProjectWalletLaunchSelection(mintAddress: string, selection: ProjectWalletLaunchSelection) {
  try {
    const key = storageKey(mintAddress);
    const walletAddresses = Array.from(new Set(selection.walletAddresses.filter((address) => typeof address === 'string'))).slice(0, MAX_SELECTION);
    if (walletAddresses.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    const buyAmounts = Object.fromEntries(Object.entries(selection.buyAmounts)
      .filter(([address, amount]) => walletAddresses.includes(address) && /^\d{1,20}(?:\.\d{1,9})?$/.test(amount.trim()) && /[1-9]/.test(amount))
      .map(([address, amount]) => [address, amount.trim()]));
    window.sessionStorage.setItem(key, JSON.stringify({
      walletAddresses,
      buyAmounts,
      buyDelaySeconds: BUY_DELAY_OPTIONS.includes(selection.buyDelaySeconds) ? selection.buyDelaySeconds : 0,
      buySlippageBps: BUY_SLIPPAGE_OPTIONS.includes(selection.buySlippageBps) ? selection.buySlippageBps : 100,
    } satisfies ProjectWalletLaunchSelection));
  } catch {
    // The token detail page still works; this only restores the user's launch selection.
  }
}

export function takeProjectWalletLaunchSelection(mintAddress: string): ProjectWalletLaunchSelection | null {
  try {
    const key = storageKey(mintAddress);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const selection = parsed as Partial<ProjectWalletLaunchSelection>;
    if (!Array.isArray(selection.walletAddresses)) return null;
    const walletAddresses = Array.from(new Set(selection.walletAddresses.filter((address): address is string => typeof address === 'string'))).slice(0, MAX_SELECTION);
    const sourceAmounts: Record<string, unknown> = selection.buyAmounts && typeof selection.buyAmounts === 'object' && !Array.isArray(selection.buyAmounts)
      ? selection.buyAmounts
      : {};
    const buyAmounts: Record<string, string> = {};
    for (const [address, amount] of Object.entries(sourceAmounts)) {
      if (walletAddresses.includes(address)
        && typeof amount === 'string'
        && /^\d{1,20}(?:\.\d{1,9})?$/.test(amount.trim())
        && /[1-9]/.test(amount)) {
        buyAmounts[address] = amount.trim();
      }
    }
    return {
      walletAddresses,
      buyAmounts,
      buyDelaySeconds: BUY_DELAY_OPTIONS.includes(selection.buyDelaySeconds as number) ? selection.buyDelaySeconds as number : 0,
      buySlippageBps: BUY_SLIPPAGE_OPTIONS.includes(selection.buySlippageBps as number) ? selection.buySlippageBps as number : 100,
    } satisfies ProjectWalletLaunchSelection;
  } catch {
    return null;
  }
}
