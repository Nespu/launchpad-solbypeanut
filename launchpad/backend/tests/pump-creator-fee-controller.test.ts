import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_PROGRAM_ID, type CreatorVaultQuoteBalance } from '@pump-fun/pump-sdk';
import {
  ComputeBudgetProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import type { Request, Response } from 'express';
import { createPumpCreatorFeeHandlers } from '../src/controllers/pumpCreatorFeeController';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function responseRecorder() {
  const result: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const response = {
    status(code: number) { result.statusCode = code; return this; },
    setHeader(name: string, value: string) { result.headers[name] = value; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  return { result, response: response as unknown as Response };
}

function mockConnection(genesisHash = DEVNET_GENESIS_HASH): Connection {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
    getGenesisHash: async () => genesisHash,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 500 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 5_000 }),
    getAccountInfo: async () => null,
  } as unknown as Connection;
}

function mockBalance(): CreatorVaultQuoteBalance {
  return {
    mint: NATIVE_MINT,
    source: 'sol',
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    pumpVault: new BN(123_000_000),
    ammVault: new BN(0),
    total: new BN(123_000_000),
  } as CreatorVaultQuoteBalance;
}

function createHandlers(genesisHash = DEVNET_GENESIS_HASH) {
  const creator = Keypair.generate().publicKey;
  const balance = mockBalance();
  const pumpInstruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [{ pubkey: creator, isSigner: true, isWritable: true }],
    data: Buffer.from([1, 2, 3]),
  });
  const sdk = {
    fetchGlobal: async () => ({ isHolderRewardEnabled: false }),
    getCreatorVaultQuoteBalances: async () => [balance],
    collectCoinCreatorFeeV2Instructions: async () => [pumpInstruction],
  };
  const handlers = createPumpCreatorFeeHandlers({
    connection: mockConnection(genesisHash),
    createSdk: () => sdk,
    readMint: async () => { throw new Error('native quote should not read mint metadata'); },
  } as never);
  return { creator, handlers };
}

test('Pump feature status reports the live Devnet Holder Rewards gate', async () => {
  const { handlers } = createHandlers();
  const { result, response } = responseRecorder();
  await handlers.status({} as Request, response);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(result.body, { success: true, network: 'devnet', holderRewardsEnabled: false });
});

test('creator fee reads refuse RPCs that are not Solana Devnet', async () => {
  const { handlers } = createHandlers('mainnet-genesis-hash');
  const { result, response } = responseRecorder();
  await handlers.balances({ query: { creator: Keypair.generate().publicKey.toBase58() } } as unknown as Request, response);
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { success: false, error: 'Wire solo prepara estas operaciones en Solana Devnet.' });
});

test('creator fee preparation returns only an unsigned, fee-estimated Devnet transaction', async () => {
  const { creator, handlers } = createHandlers();
  const { result, response } = responseRecorder();
  await handlers.prepare({ body: { creator: creator.toBase58(), quoteMint: NATIVE_MINT.toBase58() } } as Request, response);
  assert.equal(result.statusCode, 200);
  const payload = result.body as Record<string, unknown>;
  assert.equal(payload.network, 'devnet');
  assert.equal(payload.creator, creator.toBase58());
  assert.equal(payload.quoteMint, NATIVE_MINT.toBase58());
  assert.equal(payload.amountRaw, '123000000');
  assert.equal(payload.estimatedNetworkFeeLamports, 5_000);
  assert.equal(payload.lastValidBlockHeight, 500);
  assert.match(String(payload.transaction), /^[A-Za-z0-9+/]+=*$/);
  assert.match(String(payload.transactionMessageHash), /^[a-f0-9]{64}$/);

  const transaction = Transaction.from(Buffer.from(String(payload.transaction), 'base64'));
  assert.equal(transaction.feePayer?.toBase58(), creator.toBase58());
  assert.equal(transaction.instructions[0]?.programId.toBase58(), ComputeBudgetProgram.programId.toBase58());
  assert.equal(transaction.instructions[1]?.programId.toBase58(), PUMP_PROGRAM_ID.toBase58());
  assert.ok(transaction.signatures.every((entry) => entry.signature === null));
});
