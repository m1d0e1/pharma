ALTER TABLE purchase_returns ADD COLUMN purchase_invoice_id TEXT;
ALTER TABLE purchase_return_items ADD COLUMN purchase_invoice_item_id INTEGER;
ALTER TABLE purchase_return_items ADD COLUMN unit TEXT;
