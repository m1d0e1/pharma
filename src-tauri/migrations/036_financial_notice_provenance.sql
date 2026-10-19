-- New notices are explicitly tagged at the moment of native creation.
-- Do not backfill or assign ownership to historical unscoped notices/patients.
CREATE TABLE IF NOT EXISTS financial_notice_native_scope (
  notice_id TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  patient_transaction_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(notice_id) REFERENCES financial_notices(id),
  FOREIGN KEY(patient_transaction_id) REFERENCES patient_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_financial_notice_native_pharmacy
  ON financial_notice_native_scope(pharmacy_id, notice_id);
