-- Appendix A G-23 requires requests/s to draw All/OK/KO, and the real Gatling
-- report does. ok_count/ko_count are incremented on the END edge, so they are
-- the responses/s split; nothing recorded the outcome against the START
-- bucket.
--
-- Nullable, following percentiles_ok/percentiles_ko: rows written before this
-- migration have no start-edge split, and the reader reports it as unavailable
-- rather than as zero. Two flat zero lines would read as "no failures"; the
-- truth is "not recorded".
ALTER TABLE "run_series_bucket" ADD COLUMN "started_ok_count" INTEGER;
ALTER TABLE "run_series_bucket" ADD COLUMN "started_ko_count" INTEGER;
