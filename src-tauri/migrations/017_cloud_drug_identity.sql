CREATE TABLE IF NOT EXISTS cloud_drug_mappings (
  cloud_id INTEGER PRIMARY KEY,
  local_drug_id INTEGER NOT NULL UNIQUE,
  last_cloud_name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (local_drug_id) REFERENCES master_drugs(id) ON DELETE CASCADE
);
