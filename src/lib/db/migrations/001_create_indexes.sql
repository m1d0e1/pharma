-- Database Performance Optimization Indexes
-- This file creates indexes for frequently queried columns
-- Run this after database initialization

-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- ============================================
-- INVENTORY INDEXES
-- ============================================

-- Index for pharmacy_id lookups (most common query)
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_id ON inventory(pharmacy_id);

-- Index for drug_id lookups
CREATE INDEX IF NOT EXISTS idx_inventory_drug_id ON inventory(drug_id);

-- Index for expiry date queries (alerts, reports)
CREATE INDEX IF NOT EXISTS idx_inventory_expiry_date ON inventory(expiry_date);

-- Composite index for low stock queries
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_quantity ON inventory(pharmacy_id, quantity);

-- Composite index for expiring items queries
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_expiry ON inventory(pharmacy_id, expiry_date);

-- Index for supplier queries
CREATE INDEX IF NOT EXISTS idx_inventory_supplier ON inventory(supplier) WHERE supplier IS NOT NULL;

-- ============================================
-- SALES INDEXES
-- ============================================

-- Index for pharmacy_id lookups
CREATE INDEX IF NOT EXISTS idx_sales_invoices_pharmacy_id ON sales_invoices(pharmacy_id);

-- Index for user_id lookups (shift reports, staff performance)
CREATE INDEX IF NOT EXISTS idx_sales_invoices_user_id ON sales_invoices(user_id);

-- Index for patient_id lookups (customer reports)
CREATE INDEX IF NOT EXISTS idx_sales_invoices_patient_id ON sales_invoices(patient_id) WHERE patient_id IS NOT NULL;

-- Index for created_at queries (date range reports)
CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_at ON sales_invoices(created_at);

-- Composite index for pharmacy + date range queries
CREATE INDEX IF NOT EXISTS idx_sales_invoices_pharmacy_date ON sales_invoices(pharmacy_id, created_at);

-- Index for payment method queries
CREATE INDEX IF NOT EXISTS idx_sales_invoices_payment_method ON sales_invoices(payment_method);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_sales_invoices_status ON sales_invoices(status);

-- ============================================
-- SALES ITEMS INDEXES
-- ============================================

-- Index for invoice_id lookups
CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_id ON sales_items(invoice_id);

-- Index for inventory_id lookups (inventory tracking)
CREATE INDEX IF NOT EXISTS idx_sales_items_inventory_id ON sales_items(inventory_id);

-- Index for drug_id lookups (drug sales reports)
CREATE INDEX IF NOT EXISTS idx_sales_items_drug_id ON sales_items(drug_id);

-- ============================================
-- USERS INDEXES
-- ============================================

-- Index for username lookups (login)
CREATE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));

-- Index for pharmacy_id lookups
CREATE INDEX IF NOT EXISTS idx_users_pharmacy_id ON users(pharmacy_id);

-- Index for role queries
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Index for active users
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = 1;

-- ============================================
-- PATIENTS INDEXES
-- ============================================

-- Index for pharmacy_id lookups
CREATE INDEX IF NOT EXISTS idx_patients_pharmacy_id ON patients(pharmacy_id);

-- Index for full_name searches
CREATE INDEX IF NOT EXISTS idx_patients_full_name ON patients(full_name COLLATE NOCASE);

-- Index for phone lookups
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone) WHERE phone IS NOT NULL;

-- ============================================
-- SHIFT REGISTERS INDEXES
-- ============================================

-- Index for pharmacy_id lookups
CREATE INDEX IF NOT EXISTS idx_shift_registers_pharmacy_id ON shift_registers(pharmacy_id);

-- Index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_shift_registers_user_id ON shift_registers(user_id);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_shift_registers_status ON shift_registers(status);

-- Index for shift_start queries (date range reports)
CREATE INDEX IF NOT EXISTS idx_shift_registers_shift_start ON shift_registers(shift_start);

-- Composite index for open shifts
CREATE INDEX IF NOT EXISTS idx_shift_registers_user_status ON shift_registers(user_id, status) WHERE status = 'open';

-- ============================================
-- MASTER DRUGS INDEXES
-- ============================================

-- Index for trade_name searches
CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name ON master_drugs(trade_name COLLATE NOCASE);

-- Index for barcode lookups (POS scanning)
CREATE INDEX IF NOT EXISTS idx_master_drugs_barcode ON master_drugs(barcode) WHERE barcode IS NOT NULL;

-- Index for category queries
CREATE INDEX IF NOT EXISTS idx_master_drugs_category ON master_drugs(category) WHERE category IS NOT NULL;

-- Index for generic_name searches
CREATE INDEX IF NOT EXISTS idx_master_drugs_generic_name ON master_drugs(generic_name COLLATE NOCASE);

-- ============================================
-- AUDIT LOGS INDEXES
-- ============================================

-- Index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

-- Index for pharmacy_id lookups
CREATE INDEX IF NOT EXISTS idx_audit_logs_pharmacy_id ON audit_logs(pharmacy_id);

-- Index for action_type queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);

-- Index for created_at queries (date range reports)
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Composite index for user + date range queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at);

-- ============================================
-- SYNC QUEUE INDEXES
-- ============================================

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);

-- Index for pending sync operations
CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue(status, created_at) WHERE status = 'pending';

-- Index for table_name queries
CREATE INDEX IF NOT EXISTS idx_sync_queue_table_name ON sync_queue(table_name);

-- ============================================
-- RETURNS INDEXES
-- ============================================

-- Index for pharmacy_id lookups
CREATE INDEX IF NOT EXISTS idx_returns_pharmacy_id ON returns(pharmacy_id);

-- Index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_returns_user_id ON returns(user_id);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);

-- Index for created_at queries
CREATE INDEX IF NOT EXISTS idx_returns_created_at ON returns(created_at);

-- ============================================
-- CASH MOVEMENTS INDEXES
-- ============================================

-- Index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_cash_movements_user_id ON cash_movements(user_id);

-- Index for shift_id lookups
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift_id ON cash_movements(shift_id);

-- Index for date queries
CREATE INDEX IF NOT EXISTS idx_cash_movements_date ON cash_movements(date);

-- Index for type queries
CREATE INDEX IF NOT EXISTS idx_cash_movements_type ON cash_movements(type);

-- ============================================
-- DAILY FINANCIAL SNAPSHOTS INDEXES
-- ============================================

-- Index for date lookups (unique)
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_financial_snapshots(date);

-- ============================================
-- REFILL REMINDERS INDEXES
-- ============================================

-- Index for patient_id lookups
CREATE INDEX IF NOT EXISTS idx_refill_reminders_patient_id ON refill_reminders(patient_id);

-- Index for drug_id lookups
CREATE INDEX IF NOT EXISTS idx_refill_reminders_drug_id ON refill_reminders(drug_id);

-- Index for next_refill_date queries
CREATE INDEX IF NOT EXISTS idx_refill_reminders_next_date ON refill_reminders(next_refill_date);

-- Index for notification status
CREATE INDEX IF NOT EXISTS idx_refill_reminders_notified ON refill_reminders(is_notified) WHERE is_notified = 0;

-- ============================================
-- PHARMACIES INDEXES
-- ============================================

-- Index for subscription_status queries
CREATE INDEX IF NOT EXISTS idx_pharmacies_subscription_status ON pharmacies(subscription_status);

-- Index for last_sync_at queries
CREATE INDEX IF NOT EXISTS idx_pharmacies_last_sync ON pharmacies(last_sync_at);

-- ============================================
-- ANALYZE TABLES FOR QUERY OPTIMIZER
-- ============================================

ANALYZE inventory;
ANALYZE sales_invoices;
ANALYZE sales_items;
ANALYZE users;
ANALYZE patients;
ANALYZE shift_registers;
ANALYZE master_drugs;
ANALYZE audit_logs;
ANALYZE sync_queue;
ANALYZE returns;
ANALYZE cash_movements;
ANALYZE daily_financial_snapshots;
ANALYZE refill_reminders;
ANALYZE pharmacies;
