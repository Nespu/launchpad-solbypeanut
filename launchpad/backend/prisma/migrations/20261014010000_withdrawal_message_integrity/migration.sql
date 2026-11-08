ALTER TABLE "Withdrawal"
  ADD COLUMN "verifiedTxHash" TEXT,
  ADD COLUMN "transactionMessageHash" TEXT,
  ADD COLUMN "lastValidBlockHeight" BIGINT;

CREATE UNIQUE INDEX "Withdrawal_verifiedTxHash_key"
  ON "Withdrawal"("verifiedTxHash");
