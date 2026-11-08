import type { Connection } from '@solana/web3.js';

export type PreparedBlockhashState = 'valid' | 'expired' | 'unrecognized';

export async function checkPreparedBlockhash(
  connection: Connection,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<PreparedBlockhashState> {
  const validity = await connection.isBlockhashValid(blockhash, { commitment: 'confirmed' });
  if (validity.value) return 'valid';

  const currentBlockHeight = await connection.getBlockHeight('confirmed');
  return currentBlockHeight > lastValidBlockHeight ? 'expired' : 'unrecognized';
}
