-- Initial Schema for Offline Pharmacy Management System
-- Version: 001
-- Description: Core tables for users, pharmacies, drugs, inventory, patients, sales, and shifts

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    pharmacy_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'pharmacist', 'cashier')),
    permissions TEXT NOT NULL, -- JSON string
    full_name TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Pharmacies Table
CREATE TABLE IF NOT EXISTS pharmacies (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    phone TEXT,
    address TEXT,
    commercial_registry TEXT,
    tax_card TEXT,
    owner_name TEXT,
    owner_phone TEXT,
    subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active',
    last_sync_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Master Drugs Table (Downloaded from Cloud)
CREATE TABLE IF NOT EXISTS master_drugs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    generic_name TEXT,
    dosage_form TEXT,
    strength TEXT,
    manufacturer TEXT,
    barcode TEXT UNIQUE,
    category TEXT,
    requires_prescription BOOLEAN DEFAULT 0,
    last_updated_at DATETIME
);

-- Inventory Table
CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    pharmacy_id TEXT NOT NULL,
    drug_id INTEGER NOT NULL,
    batch_number TEXT,
    expiry_date DATE NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    min_stock_level INTEGER DEFAULT 10,
    supplier TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (drug_id) REFERENCES master_drugs(id)
);

-- Patients Table
CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY,
    pharmacy_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sales Invoices Table
CREATE TABLE IF NOT EXISTS sales_invoices (
    id TEXT PRIMARY KEY,
    pharmacy_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    patient_id TEXT,
    total_amount REAL NOT NULL,
    payment_method TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (patient_id) REFERENCES patients(id)
);

-- Sales Items Table
CREATE TABLE IF NOT EXISTS sales_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    inventory_id TEXT NOT NULL,
    quantity_sold REAL NOT NULL,
    unit_price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id),
    FOREIGN KEY (inventory_id) REFERENCES inventory(id)
);

-- Shift Registers Table
CREATE TABLE IF NOT EXISTS shift_registers (
    id TEXT PRIMARY KEY,
    pharmacy_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    starting_cash_amount REAL NOT NULL,
    ending_cash_amount REAL,
    opening_notes TEXT,
    closing_notes TEXT,
    shift_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    shift_end DATETIME,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed', 'discrepancy')),
    verified_by TEXT,
    verified_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Sync Queue Table
CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON string
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'failed')),
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    attempted_at DATETIME
);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pharmacy_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    table_name TEXT,
    record_id TEXT,
    details TEXT, -- JSON string
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_pharmacy_id ON users(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_id ON inventory(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_inventory_drug_id ON inventory(drug_id);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry_date ON inventory(expiry_date);
CREATE INDEX IF NOT EXISTS idx_patients_pharmacy_id ON patients(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_pharmacy_id ON sales_invoices(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_user_id ON sales_invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_at ON sales_invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_id ON sales_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_shift_registers_pharmacy_id ON shift_registers(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_shift_registers_user_id ON shift_registers(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_pharmacy_id ON audit_logs(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
