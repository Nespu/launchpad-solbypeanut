CREATE TABLE IF NOT EXISTS "Token" (
  "id" TEXT NOT NULL,
  "mintAddress" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT NOT NULL,
  "totalSupply" BIGINT NOT NULL,
  "liquiditySol" DOUBLE PRECISION NOT NULL,
  "creatorWallet" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "copiedFrom" TEXT,
  "txHash" TEXT NOT NULL,
  "poolAddress" TEXT,
  "status" TEXT NOT NULL DEFAULT 'created',
  "lockType" TEXT,
  "lockDuration" INTEGER,
  "lockTxHash" TEXT,
  "auditStatus" TEXT,
  CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FeePayment" (
  "id" TEXT NOT NULL,
  "userWallet" TEXT NOT NULL,
  "tokenMint" TEXT NOT NULL,
  "amountSol" DOUBLE PRECISION NOT NULL,
  "txHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeePayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Withdrawal" (
  "id" TEXT NOT NULL,
  "userWallet" TEXT NOT NULL,
  "poolAddress" TEXT NOT NULL,
  "lpTokenAmount" DOUBLE PRECISION NOT NULL,
  "userAmount" DOUBLE PRECISION NOT NULL,
  "platformFee" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "txHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Token_mintAddress_key" ON "Token"("mintAddress");
CREATE UNIQUE INDEX IF NOT EXISTS "FeePayment_tokenMint_key" ON "FeePayment"("tokenMint");
