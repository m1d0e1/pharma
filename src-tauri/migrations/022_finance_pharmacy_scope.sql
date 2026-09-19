-- Startup compatibility adds and backfills immutable pharmacy ownership idempotently.
-- Keep a numbered marker so the SQL-plugin migration ledger remains monotonic.
SELECT 1;
