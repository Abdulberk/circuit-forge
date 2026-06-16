-- CreateEnum
CREATE TYPE "DesignJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "design_jobs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "DesignJobStatus" NOT NULL DEFAULT 'QUEUED',
    "prompt" TEXT NOT NULL,
    "constraints" TEXT,
    "maxRounds" INTEGER NOT NULL DEFAULT 2,
    "result" JSONB,
    "errorMessage" TEXT,
    "abortRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "design_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "design_jobs_orgId_createdAt_idx" ON "design_jobs"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "design_jobs_status_idx" ON "design_jobs"("status");

-- AddForeignKey
ALTER TABLE "design_jobs" ADD CONSTRAINT "design_jobs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
