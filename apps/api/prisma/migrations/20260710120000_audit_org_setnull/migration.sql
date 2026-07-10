-- Audit trail must OUTLIVE org deletion (access-transparency / SOC 2): change audit_logs.orgId from
-- ON DELETE CASCADE (which erased every audit row when an org was deleted) to ON DELETE SET NULL, matching
-- the userId/adminActor foreign keys. orgId is already nullable.

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_orgId_fkey";

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
