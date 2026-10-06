-- The portfolio home's arrival reads (GET /v1/activity): seven glance days, the
-- week's attention list, the org-wide "last run". All of them are a range over
-- run.created_at for ONE organisation, and nothing served that: the existing
-- indexes lead with test_id, project_id or status, so an org-wide arrival range
-- fell back to a scan of the whole run table. AuthGate asks this endpoint on
-- every cold load, which makes the scan the first thing every reader pays for.
--
-- DESC to match how every reader of it sorts (newest first).
CREATE INDEX "run_org_id_created_at_idx" ON "run" ("org_id", "created_at" DESC);
