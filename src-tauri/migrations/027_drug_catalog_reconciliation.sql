-- Safe, review-first drug directory reconciliation.
-- Catalog identity is deliberately separated from master_drugs.id so existing
-- installations can keep local/custom IDs without moving inventory/history.

CREATE TABLE IF NOT EXISTS drug_catalog_links (
  catalog_drug_id INTEGER PRIMARY KEY,
  master_drug_id INTEGER NOT NULL UNIQUE,
  linked_by TEXT,
  linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (master_drug_id) REFERENCES master_drugs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drug_catalog_suppressions (
  catalog_drug_id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'kept_absent_by_user',
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drug_catalog_field_policies (
  master_drug_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('local', 'catalog', 'ask')),
  updated_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (master_drug_id, field_name),
  FOREIGN KEY (master_drug_id) REFERENCES master_drugs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drug_catalog_update_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  source_name TEXT,
  preview_signature TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_drug_catalog_links_master
  ON drug_catalog_links(master_drug_id);

CREATE INDEX IF NOT EXISTS idx_drug_catalog_field_policies_drug
  ON drug_catalog_field_policies(master_drug_id);

-- Any hard deletion path (including native drug replacement) must leave a
-- tombstone so a future catalog file cannot silently resurrect the drug.
CREATE TRIGGER IF NOT EXISTS trg_master_drugs_catalog_suppress_before_delete
BEFORE DELETE ON master_drugs
WHEN EXISTS (
  SELECT 1 FROM drug_catalog_links WHERE master_drug_id = OLD.id
)
BEGIN
  INSERT INTO drug_catalog_suppressions (
    catalog_drug_id, reason, created_by, created_at, updated_at
  )
  SELECT catalog_drug_id, 'deleted_locally', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM drug_catalog_links
  WHERE master_drug_id = OLD.id
  ON CONFLICT(catalog_drug_id) DO UPDATE SET
    reason = 'deleted_locally',
    updated_at = CURRENT_TIMESTAMP;
END;
