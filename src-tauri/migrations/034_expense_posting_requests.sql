-- New native expense writes use a per-request nonce for replay defense.
-- No legacy expense IDs are inferred or altered; never rewrite migration 001.
CREATE TABLE IF NOT EXISTS expense_posting_requests (
  request_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL UNIQUE,
  pharmacy_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(expense_id) REFERENCES expenses(id)
);
