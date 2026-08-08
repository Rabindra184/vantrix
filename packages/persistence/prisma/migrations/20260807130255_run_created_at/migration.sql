-- DropIndex
DROP INDEX "run_status_started_at_idx";

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "run_status_created_at_idx" ON "run"("status", "created_at");
