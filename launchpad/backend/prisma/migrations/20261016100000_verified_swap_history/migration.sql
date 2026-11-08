CREATE TABLE "Swap" (
  "id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "userWallet" TEXT NOT NULL,
  "mintAddress" TEXT NOT NULL,
  "poolAddress" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "tokenAmountRaw" DECIMAL(30,0) NOT NULL,
  "tokenDecimals" INTEGER NOT NULL,
  "slot" BIGINT NOT NULL,
  "blockTime" TIMESTAMP(3),
  "networkFeeLamports" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Swap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Swap_signature_key" ON "Swap"("signature");
CREATE INDEX "Swap_userWallet_createdAt_idx" ON "Swap"("userWallet", "createdAt");
CREATE INDEX "Swap_userWallet_slot_idx" ON "Swap"("userWallet", "slot");
CREATE INDEX "Swap_mintAddress_createdAt_idx" ON "Swap"("mintAddress", "createdAt");
CREATE INDEX "Swap_poolAddress_createdAt_idx" ON "Swap"("poolAddress", "createdAt");
