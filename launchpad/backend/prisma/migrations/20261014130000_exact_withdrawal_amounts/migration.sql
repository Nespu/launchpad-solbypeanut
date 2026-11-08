ALTER TABLE "Withdrawal"
  ADD COLUMN IF NOT EXISTS "lpTokenAmountRaw" DECIMAL(20, 0),
  ADD COLUMN IF NOT EXISTS "userAmountLamports" BIGINT,
  ADD COLUMN IF NOT EXISTS "platformFeeLamports" BIGINT;
