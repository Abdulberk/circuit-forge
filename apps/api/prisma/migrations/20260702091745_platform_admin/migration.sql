-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('NONE', 'SUPPORT', 'OPERATOR', 'ADMIN');

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_userId_fkey";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "adminActorId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "platformRole" "PlatformRole" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "org_quota_overrides" (
    "orgId" TEXT NOT NULL,
    "simConcurrent" INTEGER,
    "simJobsPerMonth" INTEGER,
    "simRuntimeMsPerMonth" INTEGER,
    "designConcurrent" INTEGER,
    "designJobsPerMonth" INTEGER,
    "storageBytes" BIGINT,
    "partsCallsPerMonth" INTEGER,
    "updatedByAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_quota_overrides_pkey" PRIMARY KEY ("orgId")
);

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_adminActorId_createdAt_idx" ON "audit_logs"("adminActorId", "createdAt");

-- AddForeignKey
ALTER TABLE "org_quota_overrides" ADD CONSTRAINT "org_quota_overrides_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_adminActorId_fkey" FOREIGN KEY ("adminActorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
