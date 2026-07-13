-- 003_sync_metadata.sql
-- Track last sync timestamps for incremental syncing

CREATE TABLE IF NOT EXISTS sync_metadata (
  table_name TEXT PRIMARY KEY,
  last_synced_at TEXT
);
