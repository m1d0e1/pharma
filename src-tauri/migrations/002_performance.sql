-- 002_performance.sql
-- Transaction-safe indexes. Connection PRAGMAs belong outside migrations.

-- ============================================
-- INVENTORY INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_inventory_quantity ON inventory(quantity);
CREATE INDEX IF NOT EXISTS idx_inventory_drug_qty ON inventory(drug_id, quantity) WHERE quantity > 0;
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_drug_qty_expiry ON inventory(drug_id, quantity, expiry_date) WHERE quantity > 0;

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
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_user_status ON shifts(user_id, status) WHERE status = 'open';
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
