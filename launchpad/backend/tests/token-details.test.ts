   import test from 'node:test';
   import assert from 'node:assert/strict';
   import type { Request, Response } from 'express';
   import { createGetTokenDetailsHandler } from '../src/controllers/tokenControllerHandlers';

   const VALID_MINT = 'So11111111111111111111111111111111111111112';

   const ALLOWED_FIELDS = [
     'createdAt',
     'creatorWallet',
     'description',
     'imageUrl',
     'liquiditySol',
     'mintAddress',
     'name',
     'poolAddress',
     'status',
     'symbol',
     'totalSupply',
     'txHash',
   ];

   function createRequest(mintAddress: string): Request {
     return { params: { mintAddress } } as unknown as Request;
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
     result: Record<string, unknown> | null | Error,
     calls: { count: number; select?: Record<string, boolean> } = { count: 0 },
   ) {
     const store = {
       token: {
         findUnique: async (args: { select?: Record<string, boolean> }) => {
           calls.count += 1;
           calls.select = args.select;
           if (result instanceof Error) throw result;
           return result;
         },
       },
     };
     return store as never;
   }

   test('token details: mint invalido responde 400 sin consultar la base', async () => {
     const calls = { count: 0 };
     const handler = createGetTokenDetailsHandler(createStore(null, calls));
     const { res, state } = createResponse();

     await handler(createRequest('no-es-una-clave'), res);

     assert.equal(state.status, 400);
     assert.equal(state.body.success, false);
     assert.equal(calls.count, 0);
   });

   test('token details: mint valido inexistente responde 404', async () => {
     const handler = createGetTokenDetailsHandler(createStore(null));
     const { res, state } = createResponse();

     await handler(createRequest(VALID_MINT), res);

     assert.equal(state.status, 404);
     assert.equal(state.body.success, false);
   });

   test('token details: mint existente responde 200 con supply como texto y solo campos permitidos', async () => {
     const row = {
       mintAddress: VALID_MINT,
       name: 'Token de prueba',
       symbol: 'TST',
       description: null,
       imageUrl: 'https://example.com/image.png',
       totalSupply: BigInt(1000000000),
       liquiditySol: 1,
       creatorWallet: 'EdCyzRV1boyJJEjR7rBLLcRzTKQ2nGsrv4LDHuLMevMo',
       createdAt: new Date('2026-10-10T07:06:11.000Z'),
       txHash: 'firma-de-prueba',
       poolAddress: null,
       status: 'completed',
     };
     const calls: { count: number; select?: Record<string, boolean> } = { count: 0 };
     const handler = createGetTokenDetailsHandler(createStore(row, calls));
     const { res, state } = createResponse();

     await handler(createRequest(VALID_MINT), res);

     assert.equal(state.status, 200);
     assert.equal(state.body.success, true);
     assert.equal(state.body.token.totalSupply, '1000000000');
     assert.equal(typeof state.body.token.totalSupply, 'string');
     assert.deepEqual(Object.keys(state.body.token).sort(), ALLOWED_FIELDS);
     assert.deepEqual(Object.keys(calls.select ?? {}).sort(), ALLOWED_FIELDS);
     assert.ok(Object.values(calls.select ?? {}).every((value) => value === true));
   });

   test('token details: un fallo de la base responde 500 sin filtrar detalles', async () => {
     const handler = createGetTokenDetailsHandler(createStore(new Error('detalle-interno-secreto')));
     const { res, state } = createResponse();

     await handler(createRequest(VALID_MINT), res);

     assert.equal(state.status, 500);
     assert.equal(state.body.success, false);
     assert.equal(JSON.stringify(state.body).includes('detalle-interno-secreto'), false);
   });