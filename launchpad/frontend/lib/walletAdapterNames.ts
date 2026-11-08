export const DIRECT_PHANTOM_ADAPTER_NAME = 'Phantom (Wire)';

export function walletDisplayName(adapterName: string | null | undefined): string | null {
  if (!adapterName) return null;
  return adapterName === DIRECT_PHANTOM_ADAPTER_NAME ? 'Phantom' : adapterName;
}
