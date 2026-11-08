ALTER TABLE "Token"
  ADD COLUMN "launchPlatform" TEXT NOT NULL DEFAULT 'RAYDIUM',
  ADD COLUMN "bondingCurveAddress" TEXT;
