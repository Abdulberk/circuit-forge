-- AlterTable
ALTER TABLE "layout_jobs" ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "versionId" TEXT;

-- CreateIndex
CREATE INDEX "layout_jobs_versionId_idx" ON "layout_jobs"("versionId");

-- CreateIndex
CREATE INDEX "layout_jobs_projectId_idx" ON "layout_jobs"("projectId");

-- AddForeignKey
ALTER TABLE "layout_jobs" ADD CONSTRAINT "layout_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_jobs" ADD CONSTRAINT "layout_jobs_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "project_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
