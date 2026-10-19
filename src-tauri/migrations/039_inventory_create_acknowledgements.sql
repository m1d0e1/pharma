-- A posted inventory creation is unresolved until its native acknowledgement
-- is explicitly confirmed. Never infer delivery of an IPC response from COMMIT.
-- Kept separately from the immutable migration 038 creation receipts.
CREATE TABLE IF NOT EXISTS inventory_lot_create_acknowledgements (
  request_id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  acknowledged_by TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES inventory_lot_create_requests(request_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_lot_create_ack_pharmacy
  ON inventory_lot_create_acknowledgements(pharmacy_id, acknowledged_by);

-- Safe desktop batch imports may only add lots against existing authoritative
-- master catalog identities. Batch hashes are scoped to trusted actor/branch
-- and permanently prevent lost-response or altered-nonce duplicate stock.
CREATE TABLE IF NOT EXISTS inventory_lot_import_receipts (
  request_id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  inventory_ids_json TEXT NOT NULL,
  inventory_count INTEGER NOT NULL CHECK (inventory_count BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_lot_import_receipts_actor
  ON inventory_lot_import_receipts(pharmacy_id, created_by);
