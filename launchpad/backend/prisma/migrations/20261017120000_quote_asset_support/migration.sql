ALTER TABLE "Token"
  ADD COLUMN "poolQuoteMint" TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112',
  ADD COLUMN "pendingPoolQuoteMint" TEXT;

ALTER TABLE "Swap"
  ADD COLUMN "quoteAmountRaw" DECIMAL(30, 0),
  ADD COLUMN "quoteMint" TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112',
  ADD COLUMN "quoteDecimals" INTEGER NOT NULL DEFAULT 9;

UPDATE "Swap"
SET "quoteAmountRaw" = "solAmountLamports"
WHERE "solAmountLamports" IS NOT NULL;

ALTER TABLE "Withdrawal"
  ADD COLUMN "quoteAmountRaw" BIGINT,
  ADD COLUMN "platformFeeRaw" BIGINT,
  ADD COLUMN "quoteMint" TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112',
  ADD COLUMN "quoteDecimals" INTEGER NOT NULL DEFAULT 9;

UPDATE "Withdrawal"
SET "quoteAmountRaw" = COALESCE("userAmountLamports", 0) + COALESCE("platformFeeLamports", 0),
    "platformFeeRaw" = "platformFeeLamports"
WHERE "userAmountLamports" IS NOT NULL
   OR "platformFeeLamports" IS NOT NULL;
