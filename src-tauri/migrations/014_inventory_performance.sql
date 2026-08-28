-- Add composite index for fast pharmacy inventory filtering and expiry sorting
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_qty_exp ON inventory(pharmacy_id, quantity, expiry_date) WHERE quantity > 0;
