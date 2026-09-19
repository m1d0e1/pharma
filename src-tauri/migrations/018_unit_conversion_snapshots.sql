-- Snapshot columns are created and backfilled idempotently by
-- schema::prepare_legacy_database before any native business command can run.
-- Keep a numbered marker so SQL-plugin migration ledgers remain monotonic.
SELECT 1;
