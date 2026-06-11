-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_records_scopeId_period_idx" ON "usage_records"("scopeId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_scope_scopeId_metric_period_key" ON "usage_records"("scope", "scopeId", "metric", "period");
