-- CreateTable
CREATE TABLE "project_working_copies" (
    "projectId" TEXT NOT NULL,
    "circuitJson" JSONB NOT NULL,
    "uiJson" JSONB NOT NULL,
    "baseVersionId" TEXT,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_working_copies_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "project_working_copies_baseVersionId_idx" ON "project_working_copies"("baseVersionId");

-- AddForeignKey
ALTER TABLE "project_working_copies" ADD CONSTRAINT "project_working_copies_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_working_copies" ADD CONSTRAINT "project_working_copies_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "project_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_working_copies" ADD CONSTRAINT "project_working_copies_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
