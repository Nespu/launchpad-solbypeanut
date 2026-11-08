import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

const DATABASE_NAME = 'wire-project-wallet-vault';
const DATABASE_VERSION = 1;
const STORE_NAME = 'vault';
const RECORD_KEY = 'project-wallets';
const AAD_DOMAIN = 'wire:project-wallet-vault:v1:';
export const MAX_WALLETS = 100;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const KDF_PARAMS = { N: 2 ** 15, r: 8, p: 3, dkLen: 32 } as const;

export type VaultWalletRole = 'dev' | 'bundle' | 'snipe' | 'trading' | 'holder';

export type VaultWallet = {
  address: string;
  label: string;
  role: VaultWalletRole;
  createdAt: number;
};

type VaultEnvelope = {
  version: 1;
  kdf: 'scrypt';
  params: typeof KDF_PARAMS;
  salt: string;
  iv: string;
  ciphertext: string;
  wallets: VaultWallet[];
  updatedAt: number;
};

type StoredWallet = VaultWallet & { secretKey: number[] };
type VaultPayload = { wallets: StoredWallet[] };

export interface WalletVaultSession {
  readonly wallets: VaultWallet[];
  readonly isLocked: boolean;
  createWallet(label: string, role: VaultWalletRole): Promise<VaultWallet>;
  importWallet(secret: string, label: string, role: VaultWalletRole): Promise<VaultWallet>;
  updateWallet(address: string, changes: Pick<VaultWallet, 'label' | 'role'>): Promise<void>;
  signAuthenticationMessage(address: string, message: Uint8Array): Promise<Uint8Array>;
  signTransaction(address: string, transaction: Transaction): Promise<Transaction>;
  removeWallet(address: string): Promise<void>;
  lock(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VALID_ROLES = new Set<VaultWalletRole>(['dev', 'bundle', 'snipe', 'trading', 'holder']);

function asBufferSource(bytes: Uint8Array): BufferSource {
  // Web Crypto accepts Uint8Array at runtime; this narrows TS's newer generic typed-array definition.
  return bytes as unknown as BufferSource;
}

function assertCryptoAvailable() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('Este navegador no ofrece almacenamiento criptográfico seguro.');
  }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function decodeBase64(value: string, maxBytes: number) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw new Error('La bóveda cifrada no es válida.');
  }
  const binary = atob(value);
  if (binary.length > maxBytes) throw new Error('La bóveda cifrada supera el tamaño permitido.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length: number) {
  assertCryptoAvailable();
  return crypto.getRandomValues(new Uint8Array(length));
}

function validatePassphrase(passphrase: string) {
  if (passphrase.length < 12) throw new Error('La contraseña de la bóveda debe tener al menos 12 caracteres.');
  if (encoder.encode(passphrase).length > 1024) throw new Error('La contraseña supera el límite permitido.');
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array) {
  validatePassphrase(passphrase);
  const passwordBytes = encoder.encode(passphrase);
  let derived: Uint8Array | undefined;
  try {
    derived = await scryptAsync(passwordBytes, salt, {
      ...KDF_PARAMS,
      asyncTick: 10,
      maxmem: 64 * 1024 * 1024,
    });
    return await crypto.subtle.importKey('raw', asBufferSource(derived), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    passwordBytes.fill(0);
    derived?.fill(0);
  }
}

function canonicalWallets(wallets: VaultWallet[]) {
  return wallets.map(({ address, label, role, createdAt }) => ({ address, label, role, createdAt }));
}

function walletMetadataAad(wallets: VaultWallet[]) {
  return encoder.encode(`${AAD_DOMAIN}${JSON.stringify(canonicalWallets(wallets))}`);
}

function openVaultDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB no está disponible en este navegador.'));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir la bóveda local.'));
    request.onblocked = () => reject(new Error('Cierra las otras pestañas de Wire para abrir la bóveda.'));
  });
}

async function readEnvelope() {
  const database = await openVaultDatabase();
  try {
    return await new Promise<VaultEnvelope | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve((request.result as VaultEnvelope | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('No se pudo leer la bóveda local.'));
    });
  } finally {
    database.close();
  }
}

async function writeEnvelope(envelope: VaultEnvelope) {
  const database = await openVaultDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(envelope, RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('No se pudo guardar la bóveda local.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('No se pudo guardar la bóveda local.'));
    });
  } finally {
    database.close();
  }
}

function validateWalletMetadata(input: unknown): VaultWallet[] {
  if (!Array.isArray(input) || input.length > MAX_WALLETS) throw new Error('La lista de wallets de la bóveda no es válida.');
  const seen = new Set<string>();
  return input.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('La lista de wallets de la bóveda no es válida.');
    const wallet = candidate as Partial<VaultWallet>;
    if (typeof wallet.address !== 'string' || typeof wallet.label !== 'string' || !VALID_ROLES.has(wallet.role as VaultWalletRole)
      || typeof wallet.createdAt !== 'number' || !Number.isSafeInteger(wallet.createdAt) || wallet.createdAt <= 0) {
      throw new Error('La lista de wallets de la bóveda no es válida.');
    }
    let address: string;
    try { address = new PublicKey(wallet.address).toBase58(); } catch { throw new Error('La lista de wallets de la bóveda no es válida.'); }
    if (address !== wallet.address || seen.has(address) || wallet.label.length > 40) throw new Error('La lista de wallets de la bóveda no es válida.');
    seen.add(address);
    return { address, label: wallet.label, role: wallet.role as VaultWalletRole, createdAt: wallet.createdAt };
  });
}

function parseEnvelope(input: unknown): VaultEnvelope {
  if (!input || typeof input !== 'object') throw new Error('El archivo no contiene una bóveda Wire válida.');
  const value = input as Partial<VaultEnvelope>;
  if (value.version !== 1 || value.kdf !== 'scrypt' || !value.params
    || value.params.N !== KDF_PARAMS.N || value.params.r !== KDF_PARAMS.r
    || value.params.p !== KDF_PARAMS.p || value.params.dkLen !== KDF_PARAMS.dkLen
    || typeof value.salt !== 'string' || typeof value.iv !== 'string'
    || typeof value.ciphertext !== 'string' || typeof value.updatedAt !== 'number') {
    throw new Error('La versión o los parámetros de la bóveda no son compatibles.');
  }
  const salt = decodeBase64(value.salt, 16);
  const iv = decodeBase64(value.iv, 12);
  const ciphertext = decodeBase64(value.ciphertext, MAX_CIPHERTEXT_BYTES);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('La bóveda cifrada no es válida.');
  return {
    version: 1,
    kdf: 'scrypt',
    params: KDF_PARAMS,
    salt: value.salt,
    iv: value.iv,
    ciphertext: value.ciphertext,
    wallets: validateWalletMetadata(value.wallets),
    updatedAt: value.updatedAt,
  };
}

async function decryptEnvelope(envelope: VaultEnvelope, passphrase: string) {
  assertCryptoAvailable();
  const salt = decodeBase64(envelope.salt, 16);
  const iv = decodeBase64(envelope.iv, 12);
  const ciphertext = decodeBase64(envelope.ciphertext, MAX_CIPHERTEXT_BYTES);
  const key = await deriveVaultKey(passphrase, salt);
  let plaintext: Uint8Array | undefined;
  try {
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: asBufferSource(iv),
      additionalData: asBufferSource(walletMetadataAad(envelope.wallets)),
      tagLength: 128,
    }, key, asBufferSource(ciphertext));
    plaintext = new Uint8Array(decrypted);
    const parsed: unknown = JSON.parse(decoder.decode(plaintext));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as VaultPayload).wallets)) {
      throw new Error('La bóveda no contiene datos válidos.');
    }
    const secrets = new Map<string, Uint8Array>();
    try {
      const payloadWallets = (parsed as VaultPayload).wallets;
      if (payloadWallets.length !== envelope.wallets.length) throw new Error('La bóveda no coincide con sus wallets públicas.');
      for (const item of payloadWallets) {
        if (!item || typeof item.address !== 'string' || !Array.isArray(item.secretKey)
          || item.secretKey.length !== 64 || item.secretKey.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          throw new Error('La bóveda contiene una clave inválida.');
        }
        const secretKey = Uint8Array.from(item.secretKey);
        item.secretKey.fill(0);
        let keypair: Keypair;
        try { keypair = Keypair.fromSecretKey(secretKey); } catch {
          secretKey.fill(0);
          throw new Error('La bóveda contiene una clave inválida.');
        }
        if (keypair.publicKey.toBase58() !== item.address || !envelope.wallets.some((wallet) => wallet.address === item.address)) {
          secretKey.fill(0);
          keypair.secretKey.fill(0);
          throw new Error('La bóveda no coincide con sus wallets públicas.');
        }
        keypair.secretKey.fill(0);
        if (secrets.has(item.address)) {
          secretKey.fill(0);
          throw new Error('La bóveda contiene una wallet duplicada.');
        }
        secrets.set(item.address, secretKey);
      }
      return { key, salt, secrets };
    } catch (error) {
      for (const secret of secrets.values()) secret.fill(0);
      throw error;
    }
  } catch {
    salt.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    throw new Error('No se pudo desbloquear la bóveda. Revisa la contraseña o restaura una copia válida.');
  } finally {
    plaintext?.fill(0);
  }
}

function createSession(key: CryptoKey, salt: Uint8Array, wallets: VaultWallet[], secrets: Map<string, Uint8Array>): WalletVaultSession {
  let locked = false;
  let currentWallets = wallets;

  const requireUnlocked = () => {
    if (locked) throw new Error('La bóveda está bloqueada. Desbloquéala para continuar.');
  };

  const persist = async () => {
    requireUnlocked();
    const iv = randomBytes(12);
    const payload: VaultPayload = { wallets: currentWallets.map((wallet) => ({
      ...wallet,
      secretKey: Array.from(secrets.get(wallet.address) ?? []),
    })) };
    let plaintext: Uint8Array | undefined;
    try {
      if (payload.wallets.some((wallet) => wallet.secretKey.length !== 64)) throw new Error('No se pudo preparar una clave para guardar.');
      plaintext = encoder.encode(JSON.stringify(payload));
      const ciphertext = await crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv: asBufferSource(iv),
        additionalData: asBufferSource(walletMetadataAad(currentWallets)),
        tagLength: 128,
      }, key, asBufferSource(plaintext));
      requireUnlocked();
      await writeEnvelope({
        version: 1,
        kdf: 'scrypt',
        params: KDF_PARAMS,
        salt: encodeBase64(salt),
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        wallets: canonicalWallets(currentWallets),
        updatedAt: Date.now(),
      });
    } finally {
      plaintext?.fill(0);
      iv.fill(0);
      for (const wallet of payload.wallets) wallet.secretKey.fill(0);
    }
  };

  return {
    get wallets() { return currentWallets.map((wallet) => ({ ...wallet })); },
    get isLocked() { return locked; },
    async createWallet(label, role) {
      requireUnlocked();
      if (currentWallets.length >= MAX_WALLETS) throw new Error(`La bóveda admite hasta ${MAX_WALLETS} wallets.`);
      if (!VALID_ROLES.has(role)) throw new Error('El rol de wallet no es válido.');
      const keypair = Keypair.generate();
      const address = keypair.publicKey.toBase58();
      const secretKey = keypair.secretKey.slice();
      keypair.secretKey.fill(0);
      const wallet: VaultWallet = { address, label: label.trim().slice(0, 40), role, createdAt: Date.now() };
      secrets.set(address, secretKey);
      currentWallets = [...currentWallets, wallet];
      try { await persist(); } catch (error) {
        currentWallets = currentWallets.filter((item) => item.address !== address);
        secrets.delete(address);
        secretKey.fill(0);
        throw error;
      }
      return { ...wallet };
    },
    async importWallet(secret, label, role) {
      requireUnlocked();
      if (currentWallets.length >= MAX_WALLETS) throw new Error(`La bóveda admite hasta ${MAX_WALLETS} wallets.`);
      if (!VALID_ROLES.has(role)) throw new Error('El rol de wallet no es válido.');
      let candidate: Uint8Array;
      try {
        const trimmed = secret.trim();
        if (trimmed.length > 1024) throw new Error();
        if (trimmed.startsWith('[')) {
          const parsed: unknown = JSON.parse(trimmed);
          if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error();
          candidate = Uint8Array.from(parsed as number[]);
        } else {
          candidate = bs58.decode(trimmed);
        }
      } catch {
        throw new Error('La clave no es válida. Usa una clave Solana base58 o un JSON de 64 bytes.');
      }
      if (candidate.length !== 64) {
        candidate.fill(0);
        throw new Error('La clave no es válida. Usa una clave Solana base58 o un JSON de 64 bytes.');
      }
      let keypair: Keypair;
      try { keypair = Keypair.fromSecretKey(candidate); } catch {
        candidate.fill(0);
        throw new Error('No se pudo validar la clave Solana.');
      }
      const address = keypair.publicKey.toBase58();
      if (currentWallets.some((wallet) => wallet.address === address)) {
        candidate.fill(0);
        keypair.secretKey.fill(0);
        throw new Error('Esa wallet ya está en la bóveda.');
      }
      const secretKey = keypair.secretKey.slice();
      candidate.fill(0);
      keypair.secretKey.fill(0);
      const wallet: VaultWallet = { address, label: label.trim().slice(0, 40), role, createdAt: Date.now() };
      secrets.set(address, secretKey);
      currentWallets = [...currentWallets, wallet];
      try { await persist(); } catch (error) {
        currentWallets = currentWallets.filter((item) => item.address !== address);
        secrets.delete(address);
        secretKey.fill(0);
        throw error;
      }
      return { ...wallet };
    },
    async updateWallet(address, changes) {
      requireUnlocked();
      if (!VALID_ROLES.has(changes.role)) throw new Error('El rol de wallet no es válido.');
      const previous = currentWallets;
      currentWallets = currentWallets.map((wallet) => wallet.address === address
        ? { ...wallet, label: changes.label.trim().slice(0, 40), role: changes.role }
        : wallet);
      if (currentWallets.every((wallet, index) => wallet === previous[index])) throw new Error('No se encontró esa wallet en la bóveda.');
      try { await persist(); } catch (error) { currentWallets = previous; throw error; }
    },
    async signAuthenticationMessage(address, message) {
      requireUnlocked();
      const canonicalAddress = new PublicKey(address).toBase58();
      const secret = secrets.get(canonicalAddress);
      if (!secret || !currentWallets.some((wallet) => wallet.address === canonicalAddress)) {
        throw new Error('No se encontró esa wallet en la bóveda.');
      }
      if (!(message instanceof Uint8Array) || message.length < 100 || message.length > 2048) {
        throw new Error('El mensaje de identificación no es válido.');
      }
      let decodedMessage: string;
      try { decodedMessage = new TextDecoder('utf-8', { fatal: true }).decode(message); } catch {
        throw new Error('El mensaje de identificación no es válido.');
      }
      const prefix = `Wire wallet identity verification\nWallet: ${canonicalAddress}\nOrigin: `;
      const suffix = '\n\nSign this message to identify this wallet to Wire. This is not a transaction and does not spend SOL.';
      if (!decodedMessage.startsWith(prefix) || !decodedMessage.endsWith(suffix)) {
        throw new Error('Solo se pueden firmar mensajes de identificación de Wire.');
      }

      const temporarySeed = secret.slice(0, 32);
      try {
        return ed25519.sign(message, temporarySeed);
      } finally {
        temporarySeed.fill(0);
      }
    },
    async signTransaction(address, transaction) {
      requireUnlocked();
      const canonicalAddress = new PublicKey(address).toBase58();
      const secret = secrets.get(canonicalAddress);
      if (!secret || !currentWallets.some((wallet) => wallet.address === canonicalAddress)) {
        throw new Error('No se encontró esa wallet en la bóveda.');
      }
      if (!transaction.feePayer?.equals(new PublicKey(canonicalAddress))) {
        throw new Error('La transacción no asigna esta wallet como pagadora de la comisión.');
      }
      if (!transaction.recentBlockhash) throw new Error('La transacción no tiene un blockhash vigente.');
      const message = transaction.compileMessage();
      const isRequiredSigner = message.accountKeys.slice(0, message.header.numRequiredSignatures)
        .some((key) => key.toBase58() === canonicalAddress);
      if (!isRequiredSigner) throw new Error('La transacción no requiere la firma de esta wallet.');

      const temporarySecret = secret.slice();
      let signer: Keypair | undefined;
      try {
        signer = Keypair.fromSecretKey(temporarySecret);
        transaction.partialSign(signer);
        return transaction;
      } finally {
        temporarySecret.fill(0);
        signer?.secretKey.fill(0);
      }
    },
    async removeWallet(address) {
      requireUnlocked();
      const removed = secrets.get(address);
      const previous = currentWallets;
      if (!removed || !currentWallets.some((wallet) => wallet.address === address)) throw new Error('No se encontró esa wallet en la bóveda.');
      currentWallets = currentWallets.filter((wallet) => wallet.address !== address);
      secrets.delete(address);
      try {
        await persist();
        removed.fill(0);
      } catch (error) {
        currentWallets = previous;
        if (locked) removed.fill(0);
        else secrets.set(address, removed);
        throw error;
      }
    },
    lock() {
      if (locked) return;
      for (const secret of secrets.values()) secret.fill(0);
      secrets.clear();
      salt.fill(0);
      key = undefined as unknown as CryptoKey;
      locked = true;
    },
  };
}

export async function getWalletVaultMetadata() {
  const envelope = await readEnvelope();
  if (!envelope) return { exists: false, wallets: [] as VaultWallet[] };
  try {
    const validated = parseEnvelope(envelope);
    return { exists: true, wallets: validated.wallets };
  } catch {
    // Keep the restore path available if browser storage contains a damaged record.
    return { exists: true, wallets: [] as VaultWallet[] };
  }
}

export async function createWalletVault(passphrase: string) {
  assertCryptoAvailable();
  validatePassphrase(passphrase);
  if (await readEnvelope()) throw new Error('Ya existe una bóveda en este navegador.');
  const salt = randomBytes(16);
  const key = await deriveVaultKey(passphrase, salt);
  const session = createSession(key, salt, [], new Map());
  try {
    const iv = randomBytes(12);
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = encoder.encode(JSON.stringify({ wallets: [] } satisfies VaultPayload));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv), additionalData: asBufferSource(walletMetadataAad([])), tagLength: 128 }, key, asBufferSource(plaintext));
      await writeEnvelope({
        version: 1, kdf: 'scrypt', params: KDF_PARAMS, salt: encodeBase64(salt),
        iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)), wallets: [], updatedAt: Date.now(),
      });
    } finally {
      plaintext?.fill(0);
      iv.fill(0);
    }
    return session;
  } catch (error) {
    session.lock();
    throw error;
  }
}

export async function unlockWalletVault(passphrase: string) {
  const raw = await readEnvelope();
  if (!raw) throw new Error('Todavía no existe una bóveda en este navegador.');
  const envelope = parseEnvelope(raw);
  const { key, salt, secrets } = await decryptEnvelope(envelope, passphrase);
  return createSession(key, salt, envelope.wallets, secrets);
}

export async function exportEncryptedWalletVaultBackup() {
  const envelope = await readEnvelope();
  if (!envelope) throw new Error('Todavía no existe una bóveda para exportar.');
  return JSON.stringify({ format: 'wire-encrypted-wallet-vault', ...parseEnvelope(envelope) }, null, 2);
}

export async function restoreEncryptedWalletVaultBackup(serialized: string, passphrase: string, replaceExisting: boolean) {
  if (serialized.length > 2 * MAX_CIPHERTEXT_BYTES) throw new Error('El archivo de respaldo supera el tamaño permitido.');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error('El archivo de respaldo no es JSON válido.'); }
  if (!parsed || typeof parsed !== 'object' || (parsed as { format?: unknown }).format !== 'wire-encrypted-wallet-vault') {
    throw new Error('El archivo no es un respaldo cifrado de Wire.');
  }
  const envelope = parseEnvelope(parsed);
  const current = await readEnvelope();
  if (current && !replaceExisting) throw new Error('Confirma antes de reemplazar la bóveda guardada.');
  const { key, salt, secrets } = await decryptEnvelope(envelope, passphrase);
  const session = createSession(key, salt, envelope.wallets, secrets);
  try {
    await writeEnvelope(envelope);
    return session;
  } catch (error) {
    session.lock();
    throw error;
  }
}
