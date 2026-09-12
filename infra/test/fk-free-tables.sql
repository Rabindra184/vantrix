-- Every table carrying `org_id` that `DELETE FROM org` does NOT reach.
--
-- `cascades` is the transitive closure of CASCADE foreign keys rooted at
-- `org`: the tables a delete there cleans up on its own. Anything carrying
-- `org_id` and sitting OUTSIDE that closure has to be deleted explicitly, and
-- is what infra/clean-test-residue.sql names by hand.
--
-- Asking the database is the point. The same list read off schema.prisma
-- would be a guess -- the FK-free tables look exactly like the others there.
--
-- Partitions are excluded (`relispartition = false`): a DELETE on the
-- partitioned parent routes into them, so naming both would double-count.
WITH RECURSIVE cascades AS (
  SELECT 'org'::regclass::oid AS tbl
  UNION
  SELECT con.conrelid
    FROM pg_constraint con
    JOIN cascades c ON con.confrelid = c.tbl
   WHERE con.contype = 'f' AND con.confdeltype = 'c'
)
SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
                     AND a.attname = 'org_id'
                     AND a.attnum > 0
                     AND NOT a.attisdropped
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p')
   AND c.relispartition = false
   AND c.oid NOT IN (SELECT tbl FROM cascades)
 ORDER BY 1;
