import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_BYTES,
  PLACEHOLDER_IMAGE_URL,
  fetchTokenMetadata,
  isTrustedIpfsUrl,
  parseImageDataUrl,
} from '../src/services/tokenMetadata';
import { PublicError } from '../src/utils/publicError';

const GATEWAY = 'gateway.pinata.cloud';
const METADATA_URI = `https://${GATEWAY}/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`;
const IMAGE_URL = `https://${GATEWAY}/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dataUrl(bytes: Buffer, mime = 'image/png'): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const isPublicError = (status: number) => (error: unknown) =>
  error instanceof PublicError && error.status === status;

test('imagen: acepta un PNG valido y devuelve su tipo', () => {
  const result = parseImageDataUrl(dataUrl(Buffer.concat([PNG_HEADER, Buffer.from('datos')])));
  assert.equal(result.mime, 'image/png');
  assert.ok(result.buffer.length > 8);
});

test('imagen: rechaza tipos que no son PNG, JPEG, WebP o GIF', () => {
  assert.throws(() => parseImageDataUrl(dataUrl(PNG_HEADER, 'image/svg+xml')), isPublicError(400));
  assert.throws(() => parseImageDataUrl('data:text/html;base64,PGgxPg=='), isPublicError(400));
  assert.throws(() => parseImageDataUrl('esto-no-es-una-imagen'), isPublicError(400));
});

test('imagen: rechaza contenido que no coincide con el formato declarado', () => {
  assert.throws(() => parseImageDataUrl(dataUrl(Buffer.from('no soy un png'))), isPublicError(400));
});

test('imagen: rechaza archivos mayores al limite', () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG_HEADER.copy(big);
  assert.throws(() => parseImageDataUrl(dataUrl(big)), isPublicError(400));
});

test('url de IPFS: solo acepta https, el gateway configurado y la ruta /ipfs/<cid>', () => {
  assert.equal(isTrustedIpfsUrl(METADATA_URI, GATEWAY), true);
  assert.equal(isTrustedIpfsUrl(METADATA_URI.replace('https:', 'http:'), GATEWAY), false);
  assert.equal(isTrustedIpfsUrl('https://evil.example.com/ipfs/Qm123', GATEWAY), false);
  assert.equal(isTrustedIpfsUrl(`https://${GATEWAY}@evil.example.com/ipfs/Qm123`, GATEWAY), false);
  assert.equal(isTrustedIpfsUrl(`https://${GATEWAY}:8443/ipfs/Qm123`, GATEWAY), false);
  assert.equal(isTrustedIpfsUrl(`https://${GATEWAY}/otra/ruta`, GATEWAY), false);
  assert.equal(isTrustedIpfsUrl(`${METADATA_URI}?x=1`, GATEWAY), false);
  assert.equal(isTrustedIpfsUrl('no es una url', GATEWAY), false);
});

test('metadata: lee descripcion e imagen del JSON del gateway', async () => {
  const result = await fetchTokenMetadata(METADATA_URI, GATEWAY, {
    fetchFn: async () => jsonResponse({ name: 'Token', symbol: 'TKN', description: 'Hola mundo', image: IMAGE_URL }),
  });
  assert.deepEqual(result, { description: 'Hola mundo', image: IMAGE_URL });
});

test('metadata: acepta la imagen por defecto y una descripcion vacia', async () => {
  const result = await fetchTokenMetadata(METADATA_URI, GATEWAY, {
    fetchFn: async () => jsonResponse({ image: PLACEHOLDER_IMAGE_URL }),
  });
  assert.deepEqual(result, { description: '', image: PLACEHOLDER_IMAGE_URL });
});

test('metadata: un uri fuera del gateway se rechaza sin hacer ninguna peticion', async () => {
  let calls = 0;
  await assert.rejects(
    fetchTokenMetadata('https://evil.example.com/ipfs/Qm123', GATEWAY, {
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({});
      },
    }),
    isPublicError(400),
  );
  assert.equal(calls, 0);
});

test('metadata: rechaza una imagen que no esta en el gateway', async () => {
  await assert.rejects(
    fetchTokenMetadata(METADATA_URI, GATEWAY, {
      fetchFn: async () => jsonResponse({ description: 'x', image: 'https://evil.example.com/pixel.png' }),
    }),
    isPublicError(400),
  );
});

test('metadata: rechaza una descripcion demasiado larga', async () => {
  await assert.rejects(
    fetchTokenMetadata(METADATA_URI, GATEWAY, {
      fetchFn: async () => jsonResponse({ description: 'a'.repeat(501), image: IMAGE_URL }),
    }),
    isPublicError(400),
  );
});

test('metadata: reintenta si el gateway falla y termina bien', async () => {
  let calls = 0;
  const result = await fetchTokenMetadata(METADATA_URI, GATEWAY, {
    retryDelayMs: 0,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('gateway caido');
      return jsonResponse({ description: 'ok', image: IMAGE_URL });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.description, 'ok');
});

test('metadata: si el gateway nunca responde bien devuelve 502', async () => {
  let calls = 0;
  await assert.rejects(
    fetchTokenMetadata(METADATA_URI, GATEWAY, {
      attempts: 3,
      retryDelayMs: 0,
      fetchFn: async () => {
        calls += 1;
        return new Response('error', { status: 503 });
      },
    }),
    isPublicError(502),
  );
  assert.equal(calls, 3);
});

test('metadata: una respuesta demasiado grande se descarta', async () => {
  await assert.rejects(
    fetchTokenMetadata(METADATA_URI, GATEWAY, {
      attempts: 1,
      fetchFn: async () => new Response('x'.repeat(30_000), { status: 200 }),
    }),
    isPublicError(502),
  );
});