-- CreateTable
CREATE TABLE "run_indicator" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "under" INTEGER NOT NULL,
    "between_" INTEGER NOT NULL,
    "over" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,

    CONSTRAINT "run_indicator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_indicator_run_id_key" ON "run_indicator"("run_id");
