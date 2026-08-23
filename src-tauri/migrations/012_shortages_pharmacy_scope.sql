-- The current shortages shape is part of 001_initial.sql for fresh installs.
-- Existing databases receive pharmacy_id through schema compatibility before
-- SQLx runs this migration. Keep this migration as an idempotent ledger marker.
SELECT 1 WHERE 0;
