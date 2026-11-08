CREATE INDEX IF NOT EXISTS "Token_creatorWallet_createdAt_idx"
  ON "Token"("creatorWallet", "createdAt");

CREATE INDEX IF NOT EXISTS "Withdrawal_userWallet_createdAt_idx"
  ON "Withdrawal"("userWallet", "createdAt");

CREATE INDEX IF NOT EXISTS "FeePayment_userWallet_createdAt_idx"
  ON "FeePayment"("userWallet", "createdAt");
