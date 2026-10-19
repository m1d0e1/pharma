-- Preserve legacy paper ownership exactly as stored. Keep a creation nonce even
-- after an unposted paper is deleted so a delayed duplicate cannot recreate it.
CREATE TABLE IF NOT EXISTS commercial_paper_create_requests (
  request_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL UNIQUE,
  pharmacy_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_commercial_paper_requests_pharmacy
  ON commercial_paper_create_requests(pharmacy_id, paper_id);
