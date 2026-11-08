import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import * as raydiumSdk from '@raydium-io/raydium-sdk-v2';
import { decodeRaydiumLpMintFromAccount } from '../src/services/raydiumService';

type LayoutCase = {
  name: string;
  owner: PublicKey;
  layout: { span: number; offsetOf(field: string): number };
  field: string;
};

const layouts: LayoutCase[] = [
  { name: 'CPMM', owner: raydiumSdk.CREATE_CPMM_POOL_PROGRAM, layout: raydiumSdk.CpmmPoolInfoLayout, field: 'mintLp' },
  { name: 'AMM V4', owner: raydiumSdk.AMM_V4, layout: raydiumSdk.liquidityStateV4Layout, field: 'lpMint' },
  { name: 'stable AMM', owner: raydiumSdk.AMM_STABLE, layout: raydiumSdk.liquidityStateV4Layout, field: 'lpMint' },
  { name: 'AMM V5 model', owner: raydiumSdk.LIQUIDITY_POOL_PROGRAM_ID_V5_MODEL, layout: raydiumSdk.liquidityStateV5Layout, field: 'lpMint' },
];

for (const { name, owner, layout, field } of layouts) {
  test(`LP mint decoder reads the ${name} mint from its pool state`, () => {
    const expectedMint = new PublicKey(Buffer.alloc(32, 7));
    const data = Buffer.alloc(layout.span);
    expectedMint.toBuffer().copy(data, layout.offsetOf(field));

    const decoded = decodeRaydiumLpMintFromAccount({ owner, data }, raydiumSdk as never);

    assert(decoded.equals(expectedMint));
  });
}

test('LP mint decoder rejects a truncated pool state', () => {
  assert.throws(
    () => decodeRaydiumLpMintFromAccount({ owner: raydiumSdk.AMM_V4, data: Buffer.alloc(8) }, raydiumSdk as never),
    /No se pudo interpretar la cuenta/,
  );
});

test('LP mint decoder rejects a default mint address', () => {
  assert.throws(
    () => decodeRaydiumLpMintFromAccount({
      owner: raydiumSdk.CREATE_CPMM_POOL_PROGRAM,
      data: Buffer.alloc(raydiumSdk.CpmmPoolInfoLayout.span),
    }, raydiumSdk as never),
    /no contiene un mint LP válido/,
  );
});

test('LP mint decoder rejects unsupported Raydium programs', () => {
  assert.throws(
    () => decodeRaydiumLpMintFromAccount({ owner: new PublicKey(Buffer.alloc(32, 9)), data: Buffer.alloc(32) }, raydiumSdk as never),
    /Esta pool usa otro programa/,
  );
});
