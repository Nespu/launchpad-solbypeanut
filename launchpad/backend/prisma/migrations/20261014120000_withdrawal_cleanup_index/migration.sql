CREATE INDEX IF NOT EXISTS "Withdrawal_status_lastValidBlockHeight_idx"
  ON "Withdrawal"("status", "lastValidBlockHeight");
