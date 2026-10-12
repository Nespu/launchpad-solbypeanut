import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const publicKeySchema = z.string().min(32).max(44).refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid Solana address');

const signedTransactionSchema = z.string().min(1).max(200_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64 transaction');
const noNul = (value: string) => !value.includes('\0');

export const createTokenSchema = z.object({
  userWallet: publicKeySchema,
  name: z.string().trim().min(1).max(64).refine(noNul, 'Null bytes are not allowed'),
  symbol: z.string().trim().min(1).max(10).refine(noNul, 'Null bytes are not allowed'),
  description: z.string().max(500).refine(noNul, 'Null bytes are not allowed').optional().default(''),
  imageBase64: z.string().max(12_000_000).refine(noNul, 'Null bytes are not allowed').optional(),
  totalSupply: z.number().int().positive().max(18_446_744_073).safe(),
  liquiditySol: z.number().positive().finite(),
  copyFrom: z.string().refine(noNul, 'Null bytes are not allowed').optional(),
  securityAssets: z.array(z.enum(['mint', 'freeze', 'update']))
    .max(3)
    .refine((assets) => new Set(assets).size === assets.length, 'Security options must be unique')
    .optional()
    .default([]),
});

export const submitTransactionSchema = z.object({
  signedTransaction: signedTransactionSchema,
  mintAddress: publicKeySchema,
  userWallet: publicKeySchema,
  name: z.string().trim().min(1).max(64).refine(noNul, 'Null bytes are not allowed'),
  symbol: z.string().trim().min(1).max(10).refine(noNul, 'Null bytes are not allowed'),
  description: z.string().max(500).refine(noNul, 'Null bytes are not allowed').optional().default(''),
  imageUrl: z.string().url().max(2048),
  totalSupply: z.number().int().positive().max(18_446_744_073).safe(),
  liquiditySol: z.number().positive().finite(),
  copyFrom: z.string().refine(noNul, 'Null bytes are not allowed').optional(),
});

export const createPoolSchema = z.object({
  userWallet: publicKeySchema,
  mintAddress: publicKeySchema,
  tokenAmount: z.string().regex(/^[1-9]\d*$/).max(20),
  solAmount: z.number().positive().finite(),
});

export const submitPoolTransactionSchema = z.object({
  signedTransaction: signedTransactionSchema,
  userWallet: publicKeySchema,
  mintAddress: publicKeySchema,
  poolAddress: publicKeySchema,
});

export const withdrawLiquiditySchema = z.object({
  userWallet: publicKeySchema,
  poolAddress: publicKeySchema,
  lpTokenAmount: z.string().regex(/^[1-9]\d*$/).max(20),
});

export const updateWithdrawalResultSchema = z.object({
  withdrawalId: z.string().min(1).max(100).refine(noNul, 'Null bytes are not allowed'),
  userWallet: publicKeySchema,
  txHash: z.string().min(64).max(100).refine(noNul, 'Null bytes are not allowed').optional(),
  error: z.string().max(500).refine(noNul, 'Null bytes are not allowed').optional(),
}).refine((value) => Boolean(value.txHash || value.error), 'A transaction signature or failure reason is required');

export const lpBalanceQuerySchema = z.object({ userWallet: publicKeySchema, poolAddress: publicKeySchema });
export const myPoolsQuerySchema = z.object({ userWallet: publicKeySchema });
export const myTokensQuerySchema = z.object({ userWallet: publicKeySchema });

export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type SubmitTransactionInput = z.infer<typeof submitTransactionSchema>;
