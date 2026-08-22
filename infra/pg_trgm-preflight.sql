\echo '=== pg_trgm preflight for migration 20260821200000_run_search_trigram ==='
SELECT
  current_database()                                              AS database,
  current_user                                                    AS migration_role,
  current_setting('server_version')                               AS server_version,
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)     AS is_superuser,
  has_database_privilege(current_user, current_database(),'CREATE') AS has_create_on_db,
  EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm')      AS trgm_available,
  (SELECT bool_or(trusted) FROM pg_available_extension_versions
     WHERE name='pg_trgm')                                         AS trgm_trusted,
  (SELECT installed_version FROM pg_available_extensions
     WHERE name='pg_trgm')                                         AS already_installed;

\echo ''
\echo '=== VERDICT ==='
SELECT CASE
  WHEN (SELECT installed_version FROM pg_available_extensions WHERE name='pg_trgm') IS NOT NULL
    THEN 'PASS - pg_trgm is already installed; the migration is a no-op.'
  WHEN NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm')
    THEN 'FAIL - pg_trgm is NOT available on this server. The contrib package is missing; a DBA must install it.'
  WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    THEN 'PASS - role is superuser; CREATE EXTENSION will succeed.'
  WHEN (SELECT bool_or(trusted) FROM pg_available_extension_versions WHERE name='pg_trgm')
       AND has_database_privilege(current_user, current_database(),'CREATE')
    THEN 'PASS - pg_trgm is a trusted extension and this role has CREATE on the database.'
  WHEN (SELECT bool_or(trusted) FROM pg_available_extension_versions WHERE name='pg_trgm')
    THEN 'FAIL - trusted, but this role lacks CREATE on the database. Fix: GRANT CREATE ON DATABASE '
         || quote_ident(current_database()) || ' TO ' || quote_ident(current_user) || ';'
  ELSE 'FAIL - not trusted and not superuser; a DBA must run: CREATE EXTENSION pg_trgm;'
END AS verdict;
