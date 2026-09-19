-- Daily financial snapshots are generated after POS activity and must not overwrite
-- another pharmacy's snapshot for the same calendar date.

CREATE TABLE IF NOT EXISTS daily_financial_snapshots (
  date TEXT PRIMARY KEY,
  total_sales REAL DEFAULT 0,
  total_returns REAL DEFAULT 0,
  total_cash_movements REAL DEFAULT 0,
  net_profit REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE daily_financial_snapshots RENAME TO daily_financial_snapshots_legacy;

CREATE TABLE daily_financial_snapshots (
  date TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
  total_sales REAL DEFAULT 0,
  total_returns REAL DEFAULT 0,
  total_cash_movements REAL DEFAULT 0,
  net_profit REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date, pharmacy_id)
);

INSERT INTO daily_financial_snapshots (
  date, pharmacy_id, total_sales, total_returns, total_cash_movements, net_profit, created_at
)
SELECT
  date, 'local_default', total_sales, total_returns, total_cash_movements, net_profit, created_at
FROM daily_financial_snapshots_legacy;

DROP TABLE daily_financial_snapshots_legacy;

DROP INDEX IF EXISTS idx_daily_snapshots_date;
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_pharmacy_date
ON daily_financial_snapshots(pharmacy_id, date);
