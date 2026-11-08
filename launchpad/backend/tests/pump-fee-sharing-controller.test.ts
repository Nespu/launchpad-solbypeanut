import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Platform,
  PUMP_FEE_PROGRAM_ID,
  PumpSdk,
  feeSharingConfigPda,
  socialFeePda,
  type BondingCurve,
  type SharingConfig,
} from '@pump-fun/pump-sdk';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import type { Request, Response } from 'express';
import { createPumpFeeSharingHandlers } from '../src/controllers/pumpFeeSharingController';
import { preparePumpFeeSharingSchema } from '../src/utils/schemas';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SOCIAL_CREATE_DISCRIMINATOR = Buffer.from([144, 224, 59, 211, 78, 248, 202, 220]);
const FEE_SHARE_UPDATE_V2 = Buffer.from([111, 251, 49, 6, 78, 78, 106, 18]);

function responseRecorder() {
  const result: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const response = {
    status(code: number) { result.statusCode = code; return this; },
    setHeader(name: string, value: string) { result.headers[name] = value; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  return { result, response: response as unknown as Response };
}

function createFixture(genesisHash = DEVNET_GENESIS_HASH) {
  const signer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const configAddress = feeSharingConfigPda(mint);
  const githubId = '583231';
  const githubPda = socialFeePda(githubId, Platform.GitHub);
  const config: SharingConfig = {
    version: 2,
    mint,
    admin: signer,
    adminRevoked: false,
    shareholders: [{ address: signer, shareBps: 10_000 }],
  };
  const curve = {
    mint,
    creator: configAddress,
    quoteMint: PublicKey.default,
    complete: false,
    isHolderReward: false,
    creatorFee: new BN(0),
  } as unknown as BondingCurve;
  const feeConfigAccount = {
    data: Buffer.alloc(16),
    executable: false,
    lamports: 1,
    owner: PUMP_FEE_PROGRAM_ID,
    rentEpoch: 0,
  };
  const blockhash = Keypair.generate().publicKey.toBase58();
  const rentRequests: number[] = [];
  const rpc = {
    getGenesisHash: async () => genesisHash,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 500 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 5_000 }),
    getMinimumBalanceForRentExemption: async (bytes: number) => { rentRequests.push(bytes); return bytes === 179 ? 10_000 : 5_000; },
    simulateTransaction: async () => ({ value: { err: null } }),
    getAccountInfo: async (address: PublicKey) => address.equals(configAddress) ? feeConfigAccount : null,
  } as unknown as Connection;
  const builder = new PumpSdk() as unknown as Record<string, (...args: never[]) => unknown>;
  builder.decodeSharingConfig = () => config;
  builder.decodeSocialFeePda = () => ({ userId: githubId, platform: Platform.GitHub });
  const readSdk = {
    fetchBondingCurve: async () => curve,
    fetchQuoteTokenProgram: async () => TOKEN_PROGRAM_ID,
    getCreatorVaultQuoteBalances: async () => [],
  };
  const handlers = createPumpFeeSharingHandlers({
    connection: rpc,
    createPumpReadSdk: () => readSdk,
    createPumpInstructionBuilder: () => builder,
    createAmmSdk: () => ({ fetchPool: async () => { throw new Error('pool is not used for an ungraduated curve'); } }),
    readMint: async () => { throw new Error('SOL quote should not read mint metadata'); },
  } as never);
  return { signer, mint, configAddress, githubId, githubPda, config, rpc, handlers, rentRequests };
}

test('fee sharing status exposes a verified GitHub social recipient', async () => {
  const fixture = createFixture();
  fixture.config.shareholders = [{ address: fixture.githubPda, shareBps: 10_000 }];
  const rpc = fixture.rpc as unknown as { getAccountInfo: (address: PublicKey) => Promise<unknown> };
  rpc.getAccountInfo = async (address) => address.equals(fixture.configAddress) || address.equals(fixture.githubPda)
    ? { ...({ data: Buffer.alloc(16), executable: false, lamports: 1, rentEpoch: 0 } as const), owner: PUMP_FEE_PROGRAM_ID }
    : null;
  const { result, response } = responseRecorder();
  await fixture.handlers.status({ query: { mint: fixture.mint.toBase58(), creator: fixture.signer.toBase58() } } as unknown as Request, response);
  assert.equal(result.statusCode, 200);
  const payload = result.body as { shareholders: Array<{ type: string; userId?: string; address: string }> };
  assert.deepEqual(payload.shareholders, [{
    type: 'github',
    userId: fixture.githubId,
    address: fixture.githubPda.toBase58(),
    shareBps: 10_000,
  }]);
});

test('fee sharing finalization prepares GitHub PDA initialization and one permanent split unsigned', async () => {
  const fixture = createFixture();
  const rpc = fixture.rpc as unknown as { getAccountInfo: (address: PublicKey) => Promise<unknown> };
  const body = {
    creator: fixture.signer.toBase58(),
    mint: fixture.mint.toBase58(),
    action: 'finalize',
    shareholders: [
      { type: 'wallet', address: fixture.signer.toBase58(), shareBps: 7_000 },
      { type: 'github', userId: fixture.githubId, shareBps: 3_000 },
    ],
  };
  const first = responseRecorder();
  await fixture.handlers.prepare({ body } as unknown as Request, first.response);

  assert.equal(first.result.statusCode, 200);
  const initPayload = first.result.body as Record<string, unknown>;
  assert.equal(initPayload.action, 'initialize_social');
  assert.equal(initPayload.estimatedNetworkFeeLamports, 5_000);
  assert.equal(initPayload.estimatedRentLamports, 10_000);
  assert.deepEqual(initPayload.socialRecipientsToInitialize, [{ userId: fixture.githubId, address: fixture.githubPda.toBase58() }]);
  const initTransaction = Transaction.from(Buffer.from(String(initPayload.transaction), 'base64'));
  assert.ok(initTransaction.signatures.every((entry) => entry.signature === null));
  assert.equal(initTransaction.instructions.length, 2);
  assert.equal(initTransaction.instructions[1].programId.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58());
  assert.ok(initTransaction.instructions[1].data.subarray(0, 8).equals(SOCIAL_CREATE_DISCRIMINATOR));

  rpc.getAccountInfo = async (address) => address.equals(fixture.configAddress) || address.equals(fixture.githubPda)
    ? { data: Buffer.alloc(16), executable: false, lamports: 1, owner: PUMP_FEE_PROGRAM_ID, rentEpoch: 0 }
    : null;
  const { result, response } = responseRecorder();
  await fixture.handlers.prepare({ body } as unknown as Request, response);

  assert.equal(result.statusCode, 200);
  const payload = result.body as Record<string, unknown>;
  assert.equal(payload.action, 'finalize');
  assert.equal(payload.estimatedNetworkFeeLamports, 5_000);
  assert.equal(payload.estimatedRentLamports, 5_000);
  assert.deepEqual(payload.socialRecipientsToInitialize, []);
  const shareholders = payload.shareholders as Array<{ type: string; address: string; userId?: string; shareBps: number }>;
  assert.deepEqual(shareholders, [
    { type: 'wallet', address: fixture.signer.toBase58(), shareBps: 7_000 },
    { type: 'github', address: fixture.githubPda.toBase58(), userId: fixture.githubId, shareBps: 3_000 },
  ]);

  const transaction = Transaction.from(Buffer.from(String(payload.transaction), 'base64'));
  assert.ok(transaction.signatures.every((entry) => entry.signature === null));
  assert.equal(transaction.instructions.length, 3);
  assert.equal(transaction.instructions[2].programId.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58());
  assert.ok(transaction.instructions[2].data.subarray(0, 8).equals(FEE_SHARE_UPDATE_V2));
  assert.equal(transaction.instructions[2].data.readUInt32LE(8), 2);
  assert.equal(transaction.instructions[2].data.subarray(12, 44).toString('hex'), fixture.signer.toBuffer().toString('hex'));
  assert.equal(transaction.instructions[2].data.readUInt16LE(44), 7_000);
  assert.equal(transaction.instructions[2].data.subarray(46, 78).toString('hex'), fixture.githubPda.toBuffer().toString('hex'));
  assert.equal(transaction.instructions[2].data.readUInt16LE(78), 3_000);
  assert.ok(fixture.rentRequests.includes(179));
});

test('fee sharing schema accepts wallet and GitHub recipients only when their shares total 100%', () => {
  const fixture = createFixture();
  const accepted = preparePumpFeeSharingSchema.safeParse({
    creator: fixture.signer.toBase58(),
    mint: fixture.mint.toBase58(),
    action: 'finalize',
    shareholders: [
      { type: 'wallet', address: fixture.signer.toBase58(), shareBps: 7_000 },
      { type: 'github', userId: fixture.githubId, shareBps: 3_000 },
    ],
  });
  const rejected = preparePumpFeeSharingSchema.safeParse({
    creator: fixture.signer.toBase58(),
    mint: fixture.mint.toBase58(),
    action: 'finalize',
    shareholders: [
      { type: 'wallet', address: fixture.signer.toBase58(), shareBps: 6_000 },
      { type: 'github', userId: fixture.githubId, shareBps: 3_000 },
    ],
  });
  assert.equal(accepted.success, true);
  assert.equal(rejected.success, false);
  assert.equal(preparePumpFeeSharingSchema.safeParse({
    creator: fixture.signer.toBase58(), mint: fixture.mint.toBase58(), action: 'finalize',
    shareholders: [{ type: 'github', userId: 'github-user', shareBps: 10_000 }],
  }).success, false);
});

test('initializing the maximum nine GitHub recipients fits a Solana legacy transaction', async () => {
  const payer = Keypair.generate().publicKey;
  const sdk = new PumpSdk();
  const instructions = await Promise.all(Array.from({ length: 9 }, (_, index) => sdk.createSocialFeePda({
    payer,
    userId: `${1_000_000_000_000_000_000 + index}`,
    platform: Platform.GitHub,
  })));
  const transaction = new Transaction({ feePayer: payer, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_300_000 }), ...instructions);
  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  assert.ok(serialized.length <= 1_232);
});

test('fee sharing preparation refuses a non-Devnet RPC', async () => {
  const fixture = createFixture('mainnet-genesis-hash');
  const { result, response } = responseRecorder();
  await fixture.handlers.prepare({ body: { creator: fixture.signer.toBase58(), mint: fixture.mint.toBase58(), action: 'finalize' } } as unknown as Request, response);
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { success: false, error: 'Wire solo prepara estas operaciones en Solana Devnet.' });
});
