import { z } from "zod";

export const createTokenSchema = z.object({
  userWallet: z.string().min(32),
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(10),
  description: z.string().max(500).optional().default(""),
  imageBase64: z.string().optional(),
  totalSupply: z.number().positive(),
  liquiditySol: z.number().min(0.65, "Minimum liquidity is 0.65 SOL"),
  copyFrom: z.string().optional(),
  securityAssets: z
    .array(z.enum(["temporalLock", "totalBurn", "revokeMint", "revokeFreeze", "revokeUpdate"]))
    .optional()
    .default([]),
});

export const submitTransactionSchema = z.object({
  signedTransaction: z.string().min(1),
  mintAddress: z.string().min(32),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type SubmitTransactionInput = z.infer<typeof submitTransactionSchema>;
