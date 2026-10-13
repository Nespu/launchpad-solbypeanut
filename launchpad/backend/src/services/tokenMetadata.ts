import { cleanMetadataText } from '../utils/metadataText';
import { PublicError } from '../utils/publicError';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_DESCRIPTION_LENGTH = 500;
export const PLACEHOLDER_IMAGE_URL = 'https://via.placeholder.com/200x200?text=Memecoin';

const MAX_METADATA_BYTES = 20_000;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export interface OffChainMetadata {
  description: string;
  image: string;
}

export interface FetchMetadataOptions {
  fetchFn?: typeof fetch;
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

function hasImageSignature(mime: string, bytes: Buffer): boolean {
  switch (mime) {
    case 'image/png':
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': {
      const head = bytes.subarray(0, 6).toString('ascii');
      return head === 'GIF87a' || head === 'GIF89a';
    }
    case 'image/webp':
      return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
}

export function parseImageDataUrl(value: string): { buffer: Buffer; mime: string } {
  const match = IMAGE_DATA_URL.exec(value);
  if (!match) {
    throw new PublicError('La imagen debe ser PNG, JPEG, WebP o GIF.', 400);
  }

  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new PublicError('La imagen no puede superar 2 MB.', 400);
  }
  if (!hasImageSignature(mime, buffer)) {
    throw new PublicError('El contenido de la imagen no coincide con su formato.', 400);
  }

  return { buffer, mime };
}

export function isTrustedIpfsUrl(value: string, gateway: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === gateway.toLowerCase() &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/ipfs\/[A-Za-z0-9]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error('Metadata response is too large');
  if (!response.body) throw new Error('Metadata response has no body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error('Metadata response is too large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchTokenMetadata(
  uri: string,
  gateway: string,
  options: FetchMetadataOptions = {},
): Promise<OffChainMetadata> {
  const { fetchFn = fetch, attempts = 3, retryDelayMs = 1500, timeoutMs = 8000 } = options;

  if (!isTrustedIpfsUrl(uri, gateway)) {
    throw new PublicError('La metadata del token no apunta al almacenamiento esperado.', 400);
  }

  let parsed: unknown;
  let failed = true;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchFn(uri, {
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      parsed = JSON.parse(await readLimitedText(response, MAX_METADATA_BYTES));
      failed = false;
      break;
    } catch {
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }

  if (failed) {
    throw new PublicError('No se pudo leer la metadata del token en IPFS. Intenta registrar de nuevo en unos segundos.', 502);
  }

  const invalid = () => new PublicError('La metadata del token no es válida.', 400);
  if (typeof parsed !== 'object' || parsed === null) throw invalid();

  const { description, image } = parsed as Record<string, unknown>;
  const cleanDescription = typeof description === 'string' ? cleanMetadataText(description) : '';
  if (cleanDescription.length > MAX_DESCRIPTION_LENGTH) throw invalid();
  if (typeof image !== 'string' || (image !== PLACEHOLDER_IMAGE_URL && !isTrustedIpfsUrl(image, gateway))) {
    throw invalid();
  }

  return { description: cleanDescription, image };
}