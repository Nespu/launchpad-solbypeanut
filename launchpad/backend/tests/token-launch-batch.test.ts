import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  isTokenLaunchBatchDraft,
  MAX_TOKEN_LAUNCH_BATCH_DRAFTS,
  type TokenLaunchBatchDraft,
} from '../../frontend/lib/tokenLaunchBatch';

function readyDraft(overrides: Partial<TokenLaunchBatchDraft> = {}): TokenLaunchBatchDraft {
  return {
    id: 'draft-0001',
    createdAt: 1_797_000_000_000,
    creatorWallet: Keypair.generate().publicKey.toBase58(),
    launchPlatform: 'RAYDIUM',
    name: 'Wire Test',
    symbol: 'WIRE',
    description: 'A Devnet launch draft',
    imageBase64: 'data:image/png;base64,aGVsbG8=',
    totalSupply: '1000000000',
    liquiditySol: '1',
    securityAssets: ['mint', 'freeze', 'update'],
    holderReward: false,
    twitter: '',
    telegram: '',
    selectedProjectWalletAddresses: [],
    launchWalletBuyAmounts: {},
    launchBuyDelaySeconds: 0,
    launchBuySlippageBps: 100,
    status: 'ready',
    ...overrides,
  };
}

test('launch batch stays within the wallet create-token rate limit', () => {
  assert.equal(MAX_TOKEN_LAUNCH_BATCH_DRAFTS, 5);
});

test('accepts ready Raydium drafts and Pump.fun drafts without Raydium liquidity', () => {
  assert.equal(isTokenLaunchBatchDraft(readyDraft()), true);
  assert.equal(isTokenLaunchBatchDraft(readyDraft({ launchPlatform: 'PUMP_FUN', liquiditySol: '0', securityAssets: [] })), true);
});

test('rejects invalid image data, unselected wallet amounts, and unknown signing wallets', () => {
  const selectedWallet = Keypair.generate().publicKey.toBase58();
  assert.equal(isTokenLaunchBatchDraft(readyDraft({ imageBase64: 'https://example.test/token.png' })), false);
  assert.equal(isTokenLaunchBatchDraft(readyDraft({ launchWalletBuyAmounts: { [selectedWallet]: '0.2' } })), false);
  assert.equal(isTokenLaunchBatchDraft(readyDraft({ creatorWallet: 'not-a-public-key' })), false);
});

test('pending signed submissions stay bound to their draft identity and creator wallet', () => {
  const creatorWallet = Keypair.generate().publicKey.toBase58();
  const mintAddress = Keypair.generate().publicKey.toBase58();
  const pending = {
    attemptId: 'attempt-1',
    signedTransaction: 'AQIDBA==',
    mintAddress,
    userWallet: creatorWallet,
    launchPlatform: 'RAYDIUM' as const,
    name: 'Wire Test',
    symbol: 'WIRE',
    totalSupply: 1_000_000_000,
    liquiditySol: 1,
  };
  const draft = readyDraft({ creatorWallet, status: 'pending', mintAddress, pendingSubmission: pending });
  assert.equal(isTokenLaunchBatchDraft(draft), true);
  assert.equal(isTokenLaunchBatchDraft({ ...draft, mintAddress: Keypair.generate().publicKey.toBase58() }), false);
  assert.equal(isTokenLaunchBatchDraft({ ...draft, pendingSubmission: { ...pending, totalSupply: 2_000_000_000 } }), false);
  assert.equal(isTokenLaunchBatchDraft({ ...draft, pendingSubmission: { ...pending, userWallet: Keypair.generate().publicKey.toBase58() } }), false);
});

test('completed drafts require an Explorer transaction and canonical mint address', () => {
  const mintAddress = Keypair.generate().publicKey.toBase58();
  assert.equal(isTokenLaunchBatchDraft(readyDraft({ status: 'complete', txId: 'signature', mintAddress })), true);
  assert.equal(isTokenLaunchBatchDraft(readyDraft({ status: 'complete', txId: 'signature', mintAddress: 'invalid' })), false);
});
