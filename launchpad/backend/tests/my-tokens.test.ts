import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createGetMyTokensHandler, MY_TOKENS_LIMIT } from '../src/controllers/tokenControllerHandlers';

const VALID_WALLET = 'EdCyzRV1boyJJEjR7rBLLcRzTKQ2nGsrv4LDHuLMevMo';

const ALLOWED_FIELDS = [
  'createdAt',
  'imageUrl',
  'mintAddress',
  'name',
  'poolAddress',
  'status',
  'symbol',
];

type FindManyArgs = {
  where?: { creatorWallet?: string };
  select?: Record<string, boolean>;
  orderBy?: Record<string, string>;
  take?: number;
};

function createRequest(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

function createResponse() {
  const state: { status?: number; body?: any } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

function createStore(
  result: Array<Record<string, unknown>> | Error,
  calls: { count: number; args?: FindManyArgs } = { count: 0 },
) {
  const store = {
    token: {
      findMany: async (args: FindManyArgs) => {
        calls.count += 1;
        calls.args = args;
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return store as never;
}

test('my tokens: falta userWallet responde 400 sin consultar la base', async () => {
  const calls = { count: 0 };
  const handler = createGetMyTokensHandler(createStore([], calls));
  const { res, state } = createResponse();

  await handler(createRequest({}), res);

  assert.equal(state.status, 400);
  assert.equal(state.body.success, false);
  assert.equal(calls.count, 0);
});

test('my tokens: wallet invalida responde 400 sin consultar la base', async () => {
  const calls = { count: 0 };
  const handler = createGetMyTokensHandler(createStore([], calls));
  const { res, state } = createResponse();

  await handler(createRequest({ userWallet: 'no-es-una-wallet' }), res);

  assert.equal(state.status, 400);
  assert.equal(state.body.success, false);
  assert.equal(calls.count, 0);
});

test('my tokens: wallet valida consulta por creador, ordena por fecha y devuelve solo campos permitidos', async () => {
  const rows = [
    {
      mintAddress: 'So11111111111111111111111111111111111111112',
      name: 'Token de prueba',
      symbol: 'TST',
      imageUrl: 'https://example.com/image.png',
      poolAddress: null,
      status: 'completed',
      createdAt: new Date('2026-10-10T07:06:11.000Z'),
    },
  ];
  const calls: { count: number; args?: FindManyArgs } = { count: 0 };
  const handler = createGetMyTokensHandler(createStore(rows, calls));
  const { res, state } = createResponse();

  await handler(createRequest({ userWallet: VALID_WALLET }), res);

  assert.equal(state.status, 200);
  assert.equal(state.body.success, true);
  assert.equal(state.body.tokens.length, 1);
  assert.equal(calls.args?.where?.creatorWallet, VALID_WALLET);
  assert.deepEqual(calls.args?.orderBy, { createdAt: 'desc' });
  assert.deepEqual(Object.keys(calls.args?.select ?? {}).sort(), ALLOWED_FIELDS);
  assert.ok(Object.values(calls.args?.select ?? {}).every((value) => value === true));
});

test('my tokens: la consulta pide como maximo MY_TOKENS_LIMIT tokens', async () => {
  const calls: { count: number; args?: FindManyArgs } = { count: 0 };
  const handler = createGetMyTokensHandler(createStore([], calls));
  const { res } = createResponse();

  await handler(createRequest({ userWallet: VALID_WALLET }), res);

  assert.equal(MY_TOKENS_LIMIT, 100);
  assert.equal(calls.args?.take, MY_TOKENS_LIMIT);
});

test('my tokens: wallet sin tokens responde 200 con lista vacia', async () => {
  const handler = createGetMyTokensHandler(createStore([]));
  const { res, state } = createResponse();

  await handler(createRequest({ userWallet: VALID_WALLET }), res);

  assert.equal(state.status, 200);
  assert.deepEqual(state.body.tokens, []);
});

test('my tokens: un fallo de la base responde 500 sin filtrar detalles', async () => {
  const handler = createGetMyTokensHandler(createStore(new Error('detalle-interno-secreto')));
  const { res, state } = createResponse();

  await handler(createRequest({ userWallet: VALID_WALLET }), res);

  assert.equal(state.status, 500);
  assert.equal(state.body.success, false);
  assert.equal(JSON.stringify(state.body).includes('detalle-interno-secreto'), false);
});