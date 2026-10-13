import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PublicError } from '../utils/publicError';

const CHALLENGE_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SESSION_COOKIE = 'wire_session';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type WalletAuthStore = {
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
};

export type WalletAuthOptions = {
  allowedOrigins: string[];
  secureCookies: boolean;
  now?: () => Date;
  randomToken?: () => string;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalWallet(wallet: string): string {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new PublicError('Invalid wallet address.', 400);
  }
}

function validateOrigin(origin: string, allowedOrigins: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new PublicError('A valid browser origin is required.', 400);
  }
  if (parsed.origin !== origin || !allowedOrigins.includes(origin)) {
    throw new PublicError('Origin not allowed.', 403);
  }
  return origin;
}

function publicKeyObject(wallet: string) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(wallet).toBuffer()]),
    format: 'der',
    type: 'spki',
  });
}

function cookieHeader(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function createWalletAuthService(store: WalletAuthStore, options: WalletAuthOptions) {
  const now = options.now ?? (() => new Date());
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  const allowedOrigins = options.allowedOrigins;
  const secureCookies = options.secureCookies;

  return {
    async createChallenge(walletInput: string, originInput: string) {
      const wallet = canonicalWallet(walletInput);
      const origin = validateOrigin(originInput, allowedOrigins);
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_SECONDS * 1000);
      const nonce = randomToken();
      const message = [
        'Wire wallet identity verification',
        `Wallet: ${wallet}`,
        `Origin: ${origin}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt.toISOString()}`,
        `Expires At: ${expiresAt.toISOString()}`,
        '',
        'Sign this message to identify this wallet to Wire. This is not a transaction and does not spend SOL.',
      ].join('\n');
      await store.set(`wire:auth:challenge:${wallet}`, JSON.stringify({ wallet, origin, message }), 'EX', CHALLENGE_TTL_SECONDS);
      return { message, expiresAt: expiresAt.toISOString() };
    },

    async verifyChallenge(walletInput: string, originInput: string, message: string, signatureBase64: string) {
      const wallet = canonicalWallet(walletInput);
      const origin = validateOrigin(originInput, allowedOrigins);
      // Consume atomically before verification so a challenge can never be replayed.
      const storedValue = await store.getdel(`wire:auth:challenge:${wallet}`);
      if (!storedValue) throw new PublicError('The sign-in request expired. Please try again.', 400);

      let challenge: { wallet: string; origin: string; message: string };
      try {
        challenge = JSON.parse(storedValue);
      } catch {
        throw new PublicError('The sign-in request is invalid. Please try again.', 400);
      }
      if (challenge.wallet !== wallet || challenge.origin !== origin || challenge.message !== message) {
        throw new PublicError('The signed message does not match this sign-in request.', 400);
      }

      let signatureBytes: Buffer;
      try {
        signatureBytes = Buffer.from(signatureBase64, 'base64');
      } catch {
        throw new PublicError('Invalid wallet signature.', 400);
      }
      if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signatureBase64) {
        throw new PublicError('Invalid wallet signature.', 400);
      }

      const valid = verify(null, Buffer.from(message, 'utf8'), publicKeyObject(wallet), signatureBytes);
      if (!valid) throw new PublicError('Invalid wallet signature.', 400);

      const sessionId = randomToken();
      await store.set(`wire:auth:session:${hash(sessionId)}`, wallet, 'EX', SESSION_TTL_SECONDS);
      return {
        wallet,
        cookie: cookieHeader(sessionId, secureCookies),
        expiresInSeconds: SESSION_TTL_SECONDS,
      };
    },

    async getSession(sessionId: string | undefined): Promise<string | null> {
      if (!sessionId || !/^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) return null;
      return await store.get(`wire:auth:session:${hash(sessionId)}`);
    },

    async logout(sessionId: string | undefined): Promise<string> {
      if (sessionId && /^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) {
        await store.del(`wire:auth:session:${hash(sessionId)}`);
      }
      return clearCookieHeader(secureCookies);
    },
  };
}
