-- Columns now included in 001_initial.sql for fresh installs.
-- purchase_invoice_id added to purchase_returns
-- purchase_invoice_item_id and unit added to purchase_return_items
-- This migration is a no-op to prevent duplicate column errors on fresh installs.
-- Existing databases already have these columns from a previous migration run.
SELECT 1 WHERE 0; -- no-op sentinel
