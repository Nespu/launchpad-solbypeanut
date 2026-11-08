import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export type WalletHistorySignature = {
  signature: string;
  slot: number;
};

type TokenBalanceSnapshot = {
  accountIndex: number;
  mint: string;
  owner?: string | null;
};

type ParsedAccountKey = string | {
  pubkey?: string | { toBase58?: () => string };
  toBase58?: () => string;
};

type ParsedWalletTransaction = {
  transaction?: {
    message?: {
      accountKeys?: readonly ParsedAccountKey[];
    };
  };
  meta?: {
    preTokenBalances?: readonly TokenBalanceSnapshot[] | null;
    postTokenBalances?: readonly TokenBalanceSnapshot[] | null;
  } | null;
} | null;

function accountKeyAddress(value: ParsedAccountKey | undefined) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  const pubkey = value.pubkey;
  if (typeof pubkey === 'string') return pubkey;
  if (pubkey && typeof pubkey.toBase58 === 'function') return pubkey.toBase58();
  return null;
}

/** Finds owned token accounts in wallet transactions, including closed non-ATA accounts. */
export function getWalletOwnedTokenAccountSources(
  transaction: ParsedWalletTransaction,
  walletAddress: string,
  trackedMints: ReadonlySet<string>,
) {
  const accountKeys = transaction?.transaction?.message?.accountKeys ?? [];
  const snapshots = [
    ...(transaction?.meta?.preTokenBalances ?? []),
    ...(transaction?.meta?.postTokenBalances ?? []),
  ];
  const sources = new Map<string, { address: string; mintAddress: string }>();

  for (const balance of snapshots) {
    if (balance.owner !== walletAddress || !trackedMints.has(balance.mint)) continue;
    if (!Number.isInteger(balance.accountIndex) || balance.accountIndex < 0) continue;
    const address = accountKeyAddress(accountKeys[balance.accountIndex]);
    if (!address) continue;
    sources.set(`${address}:${balance.mint}`, { address, mintAddress: balance.mint });
  }

  return [...sources.values()];
}

export function getWalletHistorySourceAddresses(
  walletAddress: string,
  tokenAccounts: readonly { address: string; mintAddress: string }[],
  trackedMints: ReadonlySet<string>,
) {
  const addresses = new Set([walletAddress]);
  for (const account of tokenAccounts) {
    if (trackedMints.has(account.mintAddress)) addresses.add(account.address);
  }
  try {
    const owner = new PublicKey(walletAddress);
    for (const mintAddress of trackedMints) {
      try {
        const mint = new PublicKey(mintAddress);
        for (const tokenProgramId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          addresses.add(getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId).toBase58());
        }
      } catch {
        // Ignore malformed mints; other verified wallet sources remain usable.
      }
    }
  } catch {
    // Keep the owner's original source when a caller provides a non-chain fixture.
  }
  return [...addresses];
}

export function mergeWalletHistorySignatures<T extends WalletHistorySignature>(
  pages: readonly (readonly T[])[],
  exclude: ReadonlySet<string> = new Set(),
) {
  const signatures = new Map<string, T>();
  for (const page of pages) {
    for (const signature of page) {
      if (!exclude.has(signature.signature) && !signatures.has(signature.signature)) {
        signatures.set(signature.signature, signature);
      }
    }
  }
  return [...signatures.values()].sort((left, right) =>
    right.slot - left.slot || (left.signature < right.signature ? 1 : left.signature > right.signature ? -1 : 0),
  );
}

export function takeWalletHistorySignaturePage<T>(items: readonly T[], pageSize: number) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  return {
    page: items.slice(0, pageSize),
    remaining: items.slice(pageSize),
  };
}
