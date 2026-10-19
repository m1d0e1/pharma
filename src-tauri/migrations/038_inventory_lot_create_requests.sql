-- Global, append-only deduplication receipt for fixed native inventory-lot creation.
-- Deliberately NO foreign key to inventory: physical deletion of an unreferenced
-- zero-quantity lot must never make its creation request reusable.
CREATE TABLE IF NOT EXISTS inventory_lot_create_requests (
  request_id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL,
  drug_id INTEGER NOT NULL,
  pharmacy_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- Immutable digest of original typed request + native actor/pharmacy.
  -- Allows safe acknowledgement recovery after a lost IPC response without
  -- accepting a changed payload or reissuing stock.
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_lot_create_requests_lot
  ON inventory_lot_create_requests(pharmacy_id, inventory_id);
