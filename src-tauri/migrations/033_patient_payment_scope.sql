-- Forward-only provenance for *new* tenant-scoped patient payments.
-- The historical patients and patient_transactions tables have no pharmacy
-- ownership. DO NOT backfill, change migration 001, or infer an owner from a
-- patient's historical invoice relationship. The native command rejects
-- any ambiguous historical balances and records only payments it actually
-- creates under a database-held active pharmacy session.
CREATE TABLE IF NOT EXISTS patient_payment_scope (
  transaction_id TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES patient_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_patient_payment_scope_pharmacy
  ON patient_payment_scope(pharmacy_id, transaction_id);
