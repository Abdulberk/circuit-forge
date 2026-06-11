/*
  Warnings:

  - You are about to alter the column `amount` on the `usage_records` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.

*/
-- DropIndex
DROP INDEX "usage_records_scopeId_period_idx";

-- AlterTable
ALTER TABLE "usage_records" ALTER COLUMN "amount" SET DEFAULT 0,
ALTER COLUMN "amount" SET DATA TYPE INTEGER;

-- CreateIndex
CREATE INDEX "assets_orgId_idx" ON "assets"("orgId");
