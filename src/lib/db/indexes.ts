/**
 * Database Index Management
 * Applies performance indexes to the database
 */

import { getDatabase } from './client';

/**
 * Apply all database indexes for performance optimization
 * This should be called during database initialization
 */
export function applyIndexes(): void {
  const db = getDatabase();

  try {

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // ============================================
    // INVENTORY INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_id ON inventory(pharmacy_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_drug_id ON inventory(drug_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_expiry_date ON inventory(expiry_date);
      CREATE INDEX IF NOT EXISTS idx_inventory_created_at ON inventory(created_at);
      CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_quantity ON inventory(pharmacy_id, quantity);
      CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_expiry ON inventory(pharmacy_id, expiry_date);
      CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode) WHERE barcode IS NOT NULL;
    `);

    // ============================================
    // SALES INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_pharmacy_id ON sales_invoices(pharmacy_id);
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_user_id ON sales_invoices(user_id);
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_patient_id ON sales_invoices(patient_id) WHERE patient_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_at ON sales_invoices(created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_payment_method ON sales_invoices(payment_method);
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_status ON sales_invoices(status);
      CREATE INDEX IF NOT EXISTS idx_sales_invoices_shift_id ON sales_invoices(shift_id) WHERE shift_id IS NOT NULL;
    `);

    // ============================================
    // SALES ITEMS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_id ON sales_items(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_sales_items_inventory_id ON sales_items(inventory_id);
      CREATE INDEX IF NOT EXISTS idx_sales_items_drug_id ON sales_items(drug_id);
    `);

    // ============================================
    // USERS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
      CREATE INDEX IF NOT EXISTS idx_users_pharmacy_id ON users(pharmacy_id);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    `);

    // ============================================
    // PATIENTS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_patients_full_name ON patients(full_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone) WHERE phone IS NOT NULL;
    `);

    // ============================================
    // SHIFTS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shifts_user_id ON shifts(user_id);
      CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
      CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time);
    `);

    // ============================================
    // MASTER DRUGS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name ON master_drugs(trade_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name_en ON master_drugs(trade_name_en COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_master_drugs_barcode ON master_drugs(barcode) WHERE barcode IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_master_drugs_category ON master_drugs(category) WHERE category IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_master_drugs_generic_name ON master_drugs(generic_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_master_drugs_active_ingredient ON master_drugs(active_ingredient COLLATE NOCASE);
    `);

    // ============================================
    // FULL TEXT SEARCH (FTS5)
    // ============================================

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS master_drugs_fts USING fts5(
        id UNINDEXED,
        trade_name,
        trade_name_en,
        generic_name,
        active_ingredient,
        manufacturer,
        category,
        content='master_drugs',
        content_rowid='id'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS master_drugs_ai AFTER INSERT ON master_drugs BEGIN
        INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
        VALUES (new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient, new.manufacturer, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS master_drugs_ad AFTER DELETE ON master_drugs BEGIN
        INSERT INTO master_drugs_fts(master_drugs_fts, rowid, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
        VALUES('delete', old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient, old.manufacturer, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS master_drugs_au AFTER UPDATE ON master_drugs BEGIN
        INSERT INTO master_drugs_fts(master_drugs_fts, rowid, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
        VALUES('delete', old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient, old.manufacturer, old.category);
        INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
        VALUES (new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient, new.manufacturer, new.category);
      END;
    `);

    // Initial population of FTS table if empty
    const ftsCount = db.prepare('SELECT count(*) as count FROM master_drugs_fts').get() as { count: number };
    if (ftsCount.count === 0) {
      console.log('Populating FTS index for the first time...');
      db.exec(`
        INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
        SELECT id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category FROM master_drugs;
      `);
    }

    // ============================================
    // ACTIVITY LOG INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON activity_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
    `);

    // ============================================
    // RETURNS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_returns_user_id ON returns(user_id);
      CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
      CREATE INDEX IF NOT EXISTS idx_returns_created_at ON returns(created_at);
      CREATE INDEX IF NOT EXISTS idx_returns_shift_id ON returns(shift_id) WHERE shift_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_returns_invoice_id ON returns(invoice_id) WHERE invoice_id IS NOT NULL;
    `);

    // ============================================
    // CASH MOVEMENTS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cash_movements_user_id ON cash_movements(user_id);
      CREATE INDEX IF NOT EXISTS idx_cash_movements_shift_id ON cash_movements(shift_id);
      CREATE INDEX IF NOT EXISTS idx_cash_movements_date ON cash_movements(date);
      CREATE INDEX IF NOT EXISTS idx_cash_movements_type ON cash_movements(type);
    `);

    // ============================================
    // REFILL REMINDERS INDEXES
    // ============================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_refill_reminders_patient_id ON refill_reminders(patient_id);
      CREATE INDEX IF NOT EXISTS idx_refill_reminders_drug_id ON refill_reminders(drug_id);
      CREATE INDEX IF NOT EXISTS idx_refill_reminders_next_date ON refill_reminders(next_refill_date);
    `);

    // ============================================
    // NEW RELATIONSHIP & CLINICAL SAFETY INDEXES
    // ============================================

    db.exec(`
      -- Drug Interactions
      CREATE INDEX IF NOT EXISTS idx_drug_interactions_ingredients ON drug_interactions(ingredient_a, ingredient_b);

      -- Clinical Safety
      CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient ON patient_allergies(patient_id);
      CREATE INDEX IF NOT EXISTS idx_patient_conditions_patient ON patient_conditions(patient_id);

      -- Financial Ledger / General Ledger
      CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(account_id);
      CREATE INDEX IF NOT EXISTS idx_journal_entries_journal ON journal_entries(journal_id);
      CREATE INDEX IF NOT EXISTS idx_daily_journals_date ON daily_journals(date);

      -- Procurement / Purchases
      CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_invoice ON purchase_invoice_items(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_drug ON purchase_invoice_items(drug_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(po_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_order_items_drug ON purchase_order_items(drug_id);

      -- Returns
      CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);

      -- Opening Balances
      CREATE INDEX IF NOT EXISTS idx_opening_balance_items_ob ON opening_balance_items(ob_id);
      CREATE INDEX IF NOT EXISTS idx_opening_balance_items_drug ON opening_balance_items(drug_id);

      -- Stock Adjustments
      CREATE INDEX IF NOT EXISTS idx_stock_adjustments_inventory ON stock_adjustments(inventory_id);

      -- Drug metadata relationships
      CREATE INDEX IF NOT EXISTS idx_drug_indications_drug ON drug_indications(drug_id);
      CREATE INDEX IF NOT EXISTS idx_drug_alternatives_drug ON drug_alternatives(drug_id);

      -- Patient Transactions & Notices
      CREATE INDEX IF NOT EXISTS idx_patient_transactions_patient ON patient_transactions(patient_id);
      CREATE INDEX IF NOT EXISTS idx_financial_notices_target ON financial_notices(target_type, target_id) WHERE target_id IS NOT NULL;
    `);

    // ANALYZE is a heavy blocking operation and is omitted from startup applyIndexes.
    // It can be run on-demand using vacuum() or analyze() in client.ts.
  } catch (error) {
    console.error('Error applying database indexes:', error);
    throw error;
  }
}

/**
 * Get index statistics for a table
 * @param tableName - Table name
 * @returns Index information
 */
export function getIndexStats(tableName: string): Array<{
  name: string;
  unique: number;
  columns: string;
}> {
  const db = getDatabase();
  return db.prepare(`
    SELECT name, "unique", sql
    FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ?
    ORDER BY name
  `).all(tableName) as any[];
}

/**
 * Get all indexes in the database
 * @returns List of all indexes
 */
export function getAllIndexes(): Array<{
  name: string;
  tableName: string;
  sql: string;
}> {
  const db = getDatabase();
  return db.prepare(`
    SELECT name, tbl_name as tableName, sql
    FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY tbl_name, name
  `).all() as any[];
}

/**
 * Drop an index
 * @param indexName - Index name to drop
 */
export function dropIndex(indexName: string): void {
  const db = getDatabase();
  db.exec(`DROP INDEX IF EXISTS ${indexName}`);
  console.log(`Dropped index: ${indexName}`);
}

/**
 * Rebuild all indexes (useful after bulk imports)
 */
export function rebuildIndexes(): void {
  const db = getDatabase();

  // Get all indexes
  const indexes = getAllIndexes();

  // Drop all indexes
  for (const index of indexes) {
    try {
      db.exec(`DROP INDEX IF EXISTS ${index.name}`);
    } catch (e) {
      console.warn(`Could not drop index ${index.name}:`, e);
    }
  }

  // Re-apply indexes
  applyIndexes();
}
