import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createWalletAuthService, type WalletAuthStore } from '../src/services/walletAuth';
import { PublicError } from '../src/utils/publicError';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const PRIVATE_KEY_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function createStore(now: () => Date) {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  const store: WalletAuthStore = {
    async set(key, value, _expiryMode, ttlSeconds) {
      rows.set(key, { value, expiresAt: now().getTime() + ttlSeconds * 1000 });
      return 'OK';
    },
    async get(key) {
      const row = rows.get(key);
      if (!row || row.expiresAt <= now().getTime()) return null;
      return row.value;
    },
    async getdel(key) {
      const row = rows.get(key);
      rows.delete(key);
      if (!row || row.expiresAt <= now().getTime()) return null;
      return row.value;
    },
    async del(key) {
      return rows.delete(key) ? 1 : 0;
    },
  };
  return { store, rows };
}

function signMessage(message: string, secretKey: Uint8Array): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PRIVATE_KEY_PREFIX, Buffer.from(secretKey).subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

test('wallet auth verifies a domain-bound message and creates a short HttpOnly session', async () => {
  let currentTime = new Date('2026-10-13T12:00:00.000Z');
  const now = () => currentTime;
  const { store } = createStore(now);
  const service = createWalletAuthService(store, {
    allowedOrigins: [ALLOWED_ORIGIN],
    secureCookies: true,
    now,
    randomToken: (() => {
      let index = 0;
      return () => `random-token-${String(++index).padStart(32, '0')}`;
    })(),
  });
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const challenge = await service.createChallenge(wallet, ALLOWED_ORIGIN);

  assert.match(challenge.message, /does not spend SOL/);
  assert.equal(Date.parse(challenge.expiresAt) - currentTime.getTime(), 5 * 60 * 1000);
  const signature = signMessage(challenge.message, keypair.secretKey);
  const result = await service.verifyChallenge(wallet, ALLOWED_ORIGIN, challenge.message, signature);
  const sessionId = result.cookie.match(/wire_session=([^;]+)/)?.[1];

  assert.equal(result.wallet, wallet);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /Secure/);
  assert.match(result.cookie, /SameSite=Lax/);
  assert.equal(await service.getSession(sessionId), wallet);
  currentTime = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000 + 1);
  assert.equal(await service.getSession(sessionId), null);
});

test('wallet auth consumes a challenge and rejects replay', async () => {
  const now = () => new Date('2026-10-13T12:00:00.000Z');
  const { store } = createStore(now);
  const service = createWalletAuthService(store, { allowedOrigins: [ALLOWED_ORIGIN], secureCookies: false, now });
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const challenge = await service.createChallenge(wallet, ALLOWED_ORIGIN);
  const signature = signMessage(challenge.message, keypair.secretKey);

  await service.verifyChallenge(wallet, ALLOWED_ORIGIN, challenge.message, signature);
  await assert.rejects(
    service.verifyChallenge(wallet, ALLOWED_ORIGIN, challenge.message, signature),
    (error: unknown) => error instanceof PublicError && error.status === 400,
  );
});

test('wallet auth rejects a wrong origin and invalid signature', async () => {
  const now = () => new Date('2026-10-13T12:00:00.000Z');
  const { store } = createStore(now);
  const service = createWalletAuthService(store, { allowedOrigins: [ALLOWED_ORIGIN], secureCookies: false, now });
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();

  await assert.rejects(
    service.createChallenge(wallet, 'https://attacker.example'),
    (error: unknown) => error instanceof PublicError && error.status === 403,
  );

  const challenge = await service.createChallenge(wallet, ALLOWED_ORIGIN);
  const invalidSignature = Buffer.alloc(64).toString('base64');
  await assert.rejects(
    service.verifyChallenge(wallet, ALLOWED_ORIGIN, challenge.message, invalidSignature),
    (error: unknown) => error instanceof PublicError && error.status === 400,
  );
});

test('wallet auth does not accept expired challenges', async () => {
  let currentTime = new Date('2026-10-13T12:00:00.000Z');
  const now = () => currentTime;
  const { store } = createStore(now);
  const service = createWalletAuthService(store, { allowedOrigins: [ALLOWED_ORIGIN], secureCookies: false, now });
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const challenge = await service.createChallenge(wallet, ALLOWED_ORIGIN);
  currentTime = new Date(currentTime.getTime() + 5 * 60 * 1000 + 1);

  await assert.rejects(
    service.verifyChallenge(wallet, ALLOWED_ORIGIN, challenge.message, signMessage(challenge.message, keypair.secretKey)),
    (error: unknown) => error instanceof PublicError && error.status === 400,
  );
});
