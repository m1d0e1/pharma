-- Add missing columns to return_items
-- Columns sale_item_id and unit now included in 001_initial.sql for fresh installs.
-- This migration is intentionally a no-op to avoid duplicate column errors on new DBs.
-- Existing databases upgraded from before 001_initial.sql was updated will keep their columns.
SELECT 1 WHERE 0; -- no-op sentinel
