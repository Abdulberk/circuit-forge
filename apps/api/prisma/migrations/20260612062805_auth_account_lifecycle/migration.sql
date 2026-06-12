-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailVerificationTokenHash" TEXT,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordResetExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordResetTokenHash" TEXT;

-- Grandfather existing accounts: they predate email verification, so treat them as already verified
-- (don't lock out current users when REQUIRE_EMAIL_VERIFICATION is later turned on).
UPDATE "users" SET "emailVerified" = true;

-- Normalize existing emails to lowercase so the now-normalized login/register path keeps matching
-- them. A collision would surface here (unique index) rather than silently; young datasets have none.
UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");
