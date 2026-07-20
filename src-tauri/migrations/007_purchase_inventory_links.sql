ALTER TABLE purchase_invoice_items ADD COLUMN inventory_id TEXT REFERENCES inventory(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_items_inventory_id ON purchase_invoice_items(inventory_id);
