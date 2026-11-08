import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { getWalletHistorySourceAddresses, getWalletOwnedTokenAccountSources, mergeWalletHistorySignatures, takeWalletHistorySignaturePage } from './walletHistorySignatureScan';

test('discovers owned non-ATA accounts from parsed wallet history for tracked mints', () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const accountA = Keypair.generate().publicKey.toBase58();
  const accountB = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const otherMint = Keypair.generate().publicKey.toBase58();

  assert.deepEqual(getWalletOwnedTokenAccountSources({
    transaction: { message: { accountKeys: [accountA, { pubkey: { toBase58: () => accountB } }] } },
    meta: {
      preTokenBalances: [{ accountIndex: 0, mint, owner: wallet }],
      postTokenBalances: [
        { accountIndex: 0, mint, owner: wallet },
        { accountIndex: 1, mint: otherMint, owner: wallet },
        { accountIndex: 1, mint, owner: 'another-wallet' },
      ],
    },
  }, wallet, new Set([mint])), [
    { address: accountA, mintAddress: mint },
  ]);
});

test('ignores malformed token account indexes and missing transaction details', () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  assert.deepEqual(getWalletOwnedTokenAccountSources({
    transaction: { message: { accountKeys: [] } },
    meta: { preTokenBalances: [{ accountIndex: -1, mint, owner: wallet }] },
  }, wallet, new Set([mint])), []);
  assert.deepEqual(getWalletOwnedTokenAccountSources(null, wallet, new Set([mint])), []);
});

test('scans the owner and only token accounts for mints in the loaded swap history', () => {
  assert.deepEqual(getWalletHistorySourceAddresses('owner', [
    { address: 'account-a', mintAddress: 'mint-a' },
    { address: 'account-b', mintAddress: 'mint-b' },
    { address: 'account-a', mintAddress: 'mint-a' },
  ], new Set(['mint-a'])), ['owner', 'account-a']);
});

test('includes open token accounts for external mints when they are part of the wallet scan', () => {
  assert.deepEqual(getWalletHistorySourceAddresses('owner', [
    { address: 'wire-token-account', mintAddress: 'wire-mint' },
    { address: 'external-token-account', mintAddress: 'external-mint' },
  ], new Set(['wire-mint', 'external-mint'])), [
    'owner', 'wire-token-account', 'external-token-account',
  ]);
});

test('includes canonical SPL and Token-2022 ATAs for tracked mints, including closed token accounts', () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenAta = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID).toBase58();
  const token2022Ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID).toBase58();
  const sources = getWalletHistorySourceAddresses(owner.toBase58(), [], new Set([mint.toBase58(), 'malformed']));

  assert.deepEqual(sources, [owner.toBase58(), tokenAta, token2022Ata]);
});

test('does not derive ATA sources for untracked mints', () => {
  const owner = Keypair.generate().publicKey;
  const trackedMint = Keypair.generate().publicKey;
  const untrackedMint = Keypair.generate().publicKey;
  const untrackedAta = getAssociatedTokenAddressSync(untrackedMint, owner, false, TOKEN_PROGRAM_ID).toBase58();
  const sources = getWalletHistorySourceAddresses(owner.toBase58(), [], new Set([trackedMint.toBase58()]));

  assert(!sources.includes(untrackedAta));
});

test('merges token-account signature pages by newest slot and removes duplicates', () => {
  const pageA = [
    { signature: 'shared', slot: 12 },
    { signature: 'older', slot: 8 },
  ];
  const pageB = [
    { signature: 'newest', slot: 20 },
    { signature: 'shared', slot: 12 },
  ];

  assert.deepEqual(mergeWalletHistorySignatures([pageA, pageB]), [
    { signature: 'newest', slot: 20 },
    { signature: 'shared', slot: 12 },
    { signature: 'older', slot: 8 },
  ]);
});

test('excludes signatures already shown on an earlier merged page', () => {
  const existing = new Set(['shown']);
  assert.deepEqual(mergeWalletHistorySignatures([
    [{ signature: 'shown', slot: 10 }, { signature: 'new', slot: 9 }],
  ], existing), [{ signature: 'new', slot: 9 }]);
});

test('keeps excess merged signatures queued for the next UI page', () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({ signature: `sig-${index}`, slot: 10 - index }));
  assert.deepEqual(takeWalletHistorySignaturePage(candidates, 3), {
    page: candidates.slice(0, 3),
    remaining: candidates.slice(3),
  });
});

test('rejects an invalid signature page size', () => {
  assert.throws(() => takeWalletHistorySignaturePage([], 0), RangeError);
  assert.throws(() => takeWalletHistorySignaturePage([], 1.5), RangeError);
});
