-- inventory_id column now included in 001_initial.sql for fresh installs.
-- This migration is a no-op to prevent duplicate column errors on fresh installs.
-- Existing databases already have this column from a previous migration run.
SELECT 1 WHERE 0; -- no-op sentinel for the ALTER TABLE
