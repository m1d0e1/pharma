-- The startup compatibility pass adds/backfills returns.pharmacy_id idempotently.
-- Keep a numbered marker so the SQL-plugin migration ledger remains monotonic.
SELECT 1;
