-- A single append-only creation receipt for bank, card and POS definitions.
-- Keep the nonce after the zero-balance definition is deleted: late retries
-- cannot recreate accounts/terminals or repost their opening-balance journals.
-- Do not backfill existing definitions or alter any historical migration.
CREATE TABLE IF NOT EXISTS finance_device_create_requests (
    request_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bank','card','pos')),
    record_id INTEGER NOT NULL,
    pharmacy_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_finance_device_create_kind
 ON finance_device_create_requests(kind, pharmacy_id, record_id);
