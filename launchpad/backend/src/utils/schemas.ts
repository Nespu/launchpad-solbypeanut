import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
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
  imageBase64: z.string()
    .max(2_800_000)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'Image must be a PNG, JPEG, WebP or GIF data URL')
    .refine(noNul, 'Null bytes are not allowed')
    .optional(),
  totalSupply: z.number().int().positive().max(18_446_744_073).safe(),
  liquiditySol: z.number().positive().finite(),
  copyFrom: publicKeySchema.optional(),
  securityAssets: z.array(z.enum(['mint', 'freeze', 'update']))
    .max(3)
    .refine((assets) => new Set(assets).size === assets.length, 'Security options must be unique')
    .optional()
    .default([]),
});

export const createPumpTokenSchema = z.object({
  userWallet: publicKeySchema,
  name: z.string().trim().min(1).max(32).refine(noNul, 'Null bytes are not allowed'),
  symbol: z.string().trim().min(1).max(8).refine(noNul, 'Null bytes are not allowed'),
  description: z.string().max(500).refine(noNul, 'Null bytes are not allowed').optional().default(''),
  imageBase64: z.string()
    .min(1)
    .max(2_800_000)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'Image must be a PNG, JPEG, WebP or GIF data URL')
    .refine(noNul, 'Null bytes are not allowed'),
  twitter: z.string().trim().max(200).url().refine((value) => value.startsWith('https://'), 'Social links must use HTTPS').optional(),
  telegram: z.string().trim().max(200).url().refine((value) => value.startsWith('https://'), 'Social links must use HTTPS').optional(),
  holderReward: z.boolean().optional().default(false),
});

export const submitPumpTokenSchema = z.object({
  attemptId: z.string().uuid(),
  signedTransaction: signedTransactionSchema,
  mintAddress: publicKeySchema,
  userWallet: publicKeySchema,
});

// description e imageUrl ya no se reciben: el servidor las lee de la
// metadata on-chain (JSON en IPFS) al registrar el token.
export const submitTransactionSchema = z.object({
  attemptId: z.string().uuid().optional(),
  signedTransaction: signedTransactionSchema,
  mintAddress: publicKeySchema,
  userWallet: publicKeySchema,
  name: z.string().trim().min(1).max(64).refine(noNul, 'Null bytes are not allowed'),
  symbol: z.string().trim().min(1).max(10).refine(noNul, 'Null bytes are not allowed'),
  totalSupply: z.number().int().positive().max(18_446_744_073).safe(),
  liquiditySol: z.number().positive().finite(),
  copyFrom: publicKeySchema.optional(),
});

export const tokenAttemptOutcomeSchema = z.object({
  attemptId: z.string().uuid(),
  userWallet: publicKeySchema,
  mintAddress: publicKeySchema,
  outcome: z.enum(['signature_rejected', 'blockhash_expired', 'rpc_mismatch', 'preflight_failed']),
});

export const createPoolSchema = z.object({
  userWallet: publicKeySchema,
  mintAddress: publicKeySchema,
  tokenAmount: z.string().regex(/^[1-9]\d*$/).max(20),
  quoteAsset: z.enum(['SOL', 'USDC']).optional().default('SOL'),
  quoteAmount: z.string().trim().min(1).max(40).regex(/^\d{1,20}(?:\.\d{1,18})?$/).optional(),
  // Accept the legacy SOL request while old browser tabs may still be open.
  solAmount: z.number().positive().finite().optional(),
}).refine((value) => value.quoteAmount !== undefined || (value.quoteAsset === 'SOL' && value.solAmount !== undefined), {
  message: 'A quote amount is required for the selected pool asset',
  path: ['quoteAmount'],
}).refine((value) => {
  const amount = value.quoteAmount ?? (value.quoteAsset === 'SOL' && value.solAmount !== undefined
    ? value.solAmount.toFixed(9).replace(/\.?0+$/, '')
    : undefined);
  if (amount === undefined || !/^\d+(?:\.\d+)?$/.test(amount)) return false;
  const [whole, fraction = ''] = amount.split('.');
  const maxDecimals = value.quoteAsset === 'USDC' ? 6 : 9;
  return fraction.length <= maxDecimals && BigInt(`${whole}${fraction}`) > 0n;
}, {
  message: 'The quote amount must be positive and use the selected asset precision',
  path: ['quoteAmount'],
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

export const prepareLpBurnSchema = z.object({
  userWallet: publicKeySchema,
  poolAddress: publicKeySchema,
  lpTokenAmount: z.string().regex(/^[1-9]\d{0,29}$/, 'Invalid raw LP amount'),
});

export const updateWithdrawalResultSchema = z.object({
  withdrawalId: z.string().min(1).max(100).refine(noNul, 'Null bytes are not allowed'),
  userWallet: publicKeySchema,
  signedTransaction: z.string().min(1).max(2_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64 transaction').optional(),
  txHash: z.string().min(87).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid Solana transaction signature')
    .refine((value) => {
      try { return bs58.decode(value).length === 64; } catch { return false; }
    }, 'Invalid Solana transaction signature').optional(),
  cancel: z.literal(true).optional(),
}).refine((value) => [value.signedTransaction, value.txHash, value.cancel].filter(Boolean).length === 1, 'Provide a signed transaction, its signature, or cancellation');

export const lpBalanceQuerySchema = z.object({
  userWallet: publicKeySchema,
  poolAddress: publicKeySchema,
  includePosition: z.enum(['true', 'false']).optional(),
});
const swapAmountSchema = z.string().trim().min(1).max(40).regex(/^\d{1,20}(?:\.\d{1,18})?$/, 'Invalid swap amount');
const swapSlippageSchema = z.coerce.number().int().min(0).max(500);
export const swapQuoteQuerySchema = z.object({
  mintAddress: publicKeySchema,
  side: z.enum(['buy', 'sell']),
  amountIn: swapAmountSchema,
  slippageBps: swapSlippageSchema,
});
export const portfolioExitQuoteSchema = z.object({
  mintAddress: publicKeySchema,
  amountRaw: z.string().regex(/^[1-9]\d{0,29}$/, 'Invalid raw token balance'),
});
export const prepareSwapSchema = swapQuoteQuerySchema.extend({ userWallet: publicKeySchema });
export const recordSwapSchema = z.object({
  userWallet: publicKeySchema,
  mintAddress: publicKeySchema,
  side: z.enum(['buy', 'sell']),
  signature: z.string().min(87).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
    .refine((value) => {
      try { return bs58.decode(value).length === 64; } catch { return false; }
    }, 'Invalid Solana transaction signature'),
});
export const myPoolsQuerySchema = z.object({ userWallet: publicKeySchema });
export const myTokensQuerySchema = z.object({ userWallet: publicKeySchema });
export const walletAuthChallengeSchema = z.object({ wallet: publicKeySchema });
export const pumpCreatorFeeBalancesQuerySchema = z.object({ creator: publicKeySchema });
export const preparePumpCreatorFeeClaimSchema = z.object({
  creator: publicKeySchema,
  quoteMint: publicKeySchema,
});
export const pumpFeeSharingStatusQuerySchema = z.object({
  creator: publicKeySchema,
  mint: publicKeySchema,
});
const pumpFeeShareRecipientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('wallet'),
    address: publicKeySchema,
    shareBps: z.number().int().min(1).max(10_000),
  }),
  z.object({
    type: z.literal('github'),
    userId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    shareBps: z.number().int().min(1).max(10_000),
  }),
]);
export const preparePumpFeeSharingSchema = z.object({
  creator: publicKeySchema,
  mint: publicKeySchema,
  action: z.enum(['create', 'finalize', 'distribute']),
  shareholders: z.array(pumpFeeShareRecipientSchema).min(1).max(10).optional(),
}).superRefine((value, context) => {
  if (value.action === 'finalize' && !value.shareholders) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['shareholders'], message: 'Shareholders are required when finalizing the split.' });
  }
  if (value.action === 'finalize' && value.shareholders
    && value.shareholders.reduce((total, shareholder) => total + shareholder.shareBps, 0) !== 10_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['shareholders'], message: 'Shareholder percentages must total exactly 100%.' });
  }
});
export const walletAuthVerifySchema = z.object({
  wallet: publicKeySchema,
  message: z.string().min(1).max(1000).refine(noNul, 'Null bytes are not allowed'),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'Invalid base64 signature'),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type SubmitTransactionInput = z.infer<typeof submitTransactionSchema>;
