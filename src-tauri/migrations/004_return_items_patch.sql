-- Add missing columns to return_items
ALTER TABLE return_items ADD COLUMN sale_item_id INTEGER;
ALTER TABLE return_items ADD COLUMN unit TEXT;
