-- CreateEnum
CREATE TYPE "LayoutJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "layout_jobs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "LayoutJobStatus" NOT NULL DEFAULT 'QUEUED',
    "circuit" JSONB NOT NULL,
    "options" JSONB,
    "result" JSONB,
    "glbKey" TEXT,
    "gerbersKey" TEXT,
    "errorMessage" TEXT,
    "abortRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "layout_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "layout_jobs_orgId_createdAt_idx" ON "layout_jobs"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "layout_jobs_status_idx" ON "layout_jobs"("status");

-- AddForeignKey
ALTER TABLE "layout_jobs" ADD CONSTRAINT "layout_jobs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
