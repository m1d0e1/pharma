-- 002_performance.sql
-- SQLite performance tuning + indexes missing from Tauri migration

-- WAL mode: allows concurrent reads during writes, biggest single perf win
PRAGMA journal_mode = WAL;

-- NORMAL sync is safe with WAL and ~2x faster than FULL
PRAGMA synchronous = NORMAL;

-- 64MB cache (default is 2MB) — drugs table alone is ~20MB
PRAGMA cache_size = -65536;

-- Memory-map up to 256MB of the DB file for faster reads
PRAGMA mmap_size = 268435456;

-- Temp tables in memory
PRAGMA temp_store = MEMORY;

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- ============================================
-- INVENTORY INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_inventory_quantity ON inventory(quantity);
CREATE INDEX IF NOT EXISTS idx_inventory_drug_qty ON inventory(drug_id, quantity) WHERE quantity > 0;

-- ============================================
-- SALES INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_sales_invoices_status ON sales_invoices(status);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_payment_method ON sales_invoices(payment_method);
CREATE INDEX IF NOT EXISTS idx_sales_items_inventory_id ON sales_items(inventory_id);

-- ============================================
-- MASTER DRUGS INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name ON master_drugs(trade_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_master_drugs_generic_name ON master_drugs(generic_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_master_drugs_active_ingredient ON master_drugs(active_ingredient COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_master_drugs_category ON master_drugs(category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_drugs_stop_dealing ON master_drugs(stop_dealing) WHERE stop_dealing = 1;

-- ============================================
-- USERS INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = 1;

-- ============================================
-- AUDIT / SHIFT / RETURNS
-- ============================================
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_shift_registers_status ON shift_registers(status);
CREATE INDEX IF NOT EXISTS idx_shift_registers_user_status ON shift_registers(user_id, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_created_at ON returns(created_at);

-- ============================================
-- CASH / FINANCIAL
-- ============================================
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift_id ON cash_movements(shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_date ON cash_movements(date);

-- ============================================
-- PATIENTS
-- ============================================
CREATE INDEX IF NOT EXISTS idx_patients_full_name ON patients(full_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone) WHERE phone IS NOT NULL;

-- ============================================
-- INTERACTIONS (queried per-drug on demand)
-- ============================================
CREATE INDEX IF NOT EXISTS idx_interactions_ingredient_a ON drug_interactions(ingredient_a);
CREATE INDEX IF NOT EXISTS idx_interactions_ingredient_b ON drug_interactions(ingredient_b);

-- Update query planner statistics
ANALYZE;
