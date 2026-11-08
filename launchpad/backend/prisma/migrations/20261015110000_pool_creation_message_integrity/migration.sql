ALTER TABLE "Token"
  ADD COLUMN IF NOT EXISTS "pendingPoolAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingPoolMessageHash" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingPoolLastValidBlockHeight" BIGINT;
