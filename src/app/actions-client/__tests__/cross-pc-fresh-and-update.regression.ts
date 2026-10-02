/** @jest-environment node */

import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockId = 0;

jest.mock('@/lib/db/tauri', () => {
  const original = jest.requireActual('@/lib/db/tauri');
  return {
    ...original,
    dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
    dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
    dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
      const result = mockDb.prepare(sql).run(...params);
      return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
    }),
    dbTransaction: jest.fn(async (callback: any) => callback(mockCreateSqliteTransactionDb(mockDb))),
    generateId: jest.fn(() => `test-id-${++mockId}`),
  };
});

let mockSession: any = { id: 'admin', role: 'owner', pharmacy_id: null };

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  getClientSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => true),
  verifyPassword: jest.fn(async () => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/shortages');
jest.unmock('@/app/actions-client/purchases');
jest.unmock('@/app/actions-client/sales');
jest.unmock('@/app/actions-client/handover');
jest.unmock('@/app/actions-client/shifts');
jest.unmock('@/app/actions-client/returns');
jest.unmock('@/app/actions-client/finance');
jest.unmock('@/app/actions-client/patients');

import { normalizeDatabaseTimestamps } from '@/lib/db/tauri';
import {
  createPurchaseInvoiceAction,
  completePurchaseInvoiceAction,
  updateCompletedPurchaseInvoiceAction,
  createPurchaseReturnAction,
  addSupplierPaymentAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';
import { getPatientProfileAction } from '@/app/actions-client/patients';
import {
  addToShortagesAction,
  getShortagesAction,
} from '@/app/actions-client/shortages';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { openShiftAction, getCurrentShiftAction } from '@/app/actions-client/shifts';
import { getHandoverDetailsAction, processHandoverAction } from '@/app/actions-client/handover';
import { createReturnAction } from '@/app/actions-client/returns';
import {
  addBankAction,
  updateBankAction,
  deleteBankAction,
  getBanksAction,
  addCardAction,
  getCardsAction,
  addPointOfSaleAction,
  updatePointOfSaleAction,
  getPointsOfSaleAction,
  addPaperAction,
  addFinancialNoticeAction,
  addPatientPaymentAction,
  createCashMovementAction,
  getPapersAction,
  updatePaperStatusAction,
  createManualJournalAction,
  getCashMovementsAction,
  getFinancialNoticesAction,
  getJournalsAction,
  getTreasuryDashboardAction,
  getTrialBalanceAction,
  saveTrialBalanceSettingAction,
  getAccountsAction,
  updateAccountAction,
} from '@/app/actions-client/finance';

function applyAllMigrations(db: Database.Database) {
  const files = [
    '001_initial.sql',
    '002_performance.sql',
    '003_sync_metadata.sql',
    '004_return_items_patch.sql',
    '005_purchase_return_details.sql',
    '006_accounting_upgrade_seed.sql',
    '007_purchase_inventory_links.sql',
    '008_patient_accounting.sql',
    '009_rebuild_master_drugs_fts.sql',
    '010_shift_handover_indexes.sql',
    '011_shift_cash_difference_account.sql',
    '012_shortages_pharmacy_scope.sql',
    '013_shift_handover_details.sql',
    '014_inventory_performance.sql',
    '015_shared_open_shift.sql',
    '016_financial_expense_wiring.sql',
    '017_cloud_drug_identity.sql',
    '018_unit_conversion_snapshots.sql',
    '019_shift_pharmacy_scope.sql',
    '020_daily_snapshot_pharmacy_scope.sql',
    '021_returns_pharmacy_scope.sql',
    '022_finance_pharmacy_scope.sql',
    '023_shift_immutable_scope.sql',
    '024_commercial_papers_pharmacy_scope.sql',
    '025_sales_item_discount_snapshot.sql',
    '026_sales_loyalty_redemption_snapshot.sql',
    '027_drug_catalog_reconciliation.sql',
    '028_finance_definitions_pharmacy_scope.sql',
  ];
  for (const file of files) {
    const sql = readFileSync(`src-tauri/migrations/${file}`, 'utf8');
    db.exec(sql);
  }
  applyLocalSchemaRepairs(db);
}

function applyV0292OrV0293Migrations(db: Database.Database) {
  const files = [
    '001_initial.sql',
    '002_performance.sql',
    '003_sync_metadata.sql',
    '004_return_items_patch.sql',
    '005_purchase_return_details.sql',
    '006_accounting_upgrade_seed.sql',
    '007_purchase_inventory_links.sql',
    '008_patient_accounting.sql',
    '009_rebuild_master_drugs_fts.sql',
    '010_shift_handover_indexes.sql',
    '011_shift_cash_difference_account.sql',
    '012_shortages_pharmacy_scope.sql',
    '013_shift_handover_details.sql',
    '014_inventory_performance.sql',
    '015_shared_open_shift.sql',
    '016_financial_expense_wiring.sql',
    '017_cloud_drug_identity.sql',
  ];
  for (const file of files) {
    db.exec(readFileSync(`src-tauri/migrations/${file}`, 'utf8'));
  }
}

function applyLocalSchemaRepairs(db: Database.Database) {
  const tableExists = (table: string) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1"
  ).get(table);
  const addCol = (table: string, col: string, typeDef: string) => {
    if (!tableExists(table)) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some(c => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeDef}`);
    }
  };

  addCol('shortages', 'pharmacy_id', "TEXT NOT NULL DEFAULT 'local_default'");
  addCol('shortages', 'requested_quantity', 'REAL DEFAULT 1');
  addCol('shortages', 'status', "TEXT DEFAULT 'pending'");
  addCol('shortages', 'priority', "TEXT DEFAULT 'normal'");
  addCol('shortages', 'notes', 'TEXT');
  addCol('shortages', 'created_at', 'DATETIME');
  addCol('purchase_invoice_items', 'barcode', 'TEXT');
  addCol('purchase_invoice_items', 'medium_to_small', 'INTEGER DEFAULT 1');
  addCol('inventory', 'medium_to_small', 'INTEGER DEFAULT 1');
  addCol('sales_items', 'large_to_medium', 'INTEGER DEFAULT 1');
  addCol('sales_items', 'medium_to_small', 'INTEGER DEFAULT 1');
  addCol('shifts', 'receiver_id', 'TEXT');
  addCol('shifts', 'actual_cash', 'REAL');
  addCol('shifts', 'transfer_amount', 'REAL DEFAULT 0');
  addCol('shifts', 'transfer_target', "TEXT DEFAULT 'vault'");
  addCol('shifts', 'cash_difference', 'REAL DEFAULT 0');
  addCol('shifts', 'pharmacy_id', 'TEXT');
  addCol('cash_movements', 'source_type', 'TEXT');
  addCol('cash_movements', 'target_name', 'TEXT');
  addCol('cash_movements', 'pharmacy_id', 'TEXT');
  addCol('daily_journals', 'pharmacy_id', 'TEXT');
  addCol('expenses', 'pharmacy_id', 'TEXT');
  addCol('financial_notices', 'pharmacy_id', 'TEXT');
  addCol('commercial_papers', 'pharmacy_id', 'TEXT');
  addCol('sales_invoices', 'points_earned', 'INTEGER DEFAULT 0');
  addCol('sales_invoices', 'user_id', 'TEXT');
  addCol('sales_invoices', 'pharmacy_id', 'TEXT');
  addCol('returns', 'pharmacy_id', 'TEXT');
  addCol('supplier_transactions', 'user_id', 'TEXT');
  addCol('supplier_transactions', 'payment_method', "TEXT DEFAULT 'cash'");
  addCol('supplier_transactions', 'date', 'TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_drug_status ON shortages(pharmacy_id, drug_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_status ON shortages(pharmacy_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_drug_id ON shortages(drug_id)');
  db.exec("UPDATE shortages SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''");
  if (tableExists('commercial_papers')) {
    db.exec("UPDATE commercial_papers SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_commercial_papers_pharmacy_due ON commercial_papers(pharmacy_id, due_date)');
  }
  db.exec('UPDATE shortages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL');
  db.exec(`
    UPDATE shifts
    SET pharmacy_id = COALESCE(
      (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(shifts.user_id AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(shifts.user_id AS TEXT)) LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';

    UPDATE cash_movements
    SET pharmacy_id = COALESCE(
      (SELECT NULLIF(TRIM(s.pharmacy_id), '') FROM shifts s WHERE s.id = cash_movements.shift_id LIMIT 1),
      (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(cash_movements.user_id AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(cash_movements.user_id AS TEXT)) LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';

    UPDATE daily_journals
    SET pharmacy_id = COALESCE(
      (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(daily_journals.created_by AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(daily_journals.created_by AS TEXT)) LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';

    UPDATE expenses
    SET pharmacy_id = COALESCE(
      (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(expenses.user_id AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(expenses.user_id AS TEXT)) LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';

    UPDATE financial_notices
    SET pharmacy_id = COALESCE(
      (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(financial_notices.user_id AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(financial_notices.user_id AS TEXT)) LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';

    UPDATE sales_invoices
    SET pharmacy_id = COALESCE(
      (SELECT COALESCE(NULLIF(TRIM(u.pharmacy_id), ''), 'local_default')
       FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(sales_invoices.user_id AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(sales_invoices.user_id AS TEXT))
       LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';

    UPDATE returns
    SET pharmacy_id = COALESCE(
      (SELECT COALESCE(NULLIF(TRIM(si.pharmacy_id), ''), 'local_default')
       FROM sales_invoices si
       WHERE si.id = returns.invoice_id),
      (SELECT COALESCE(NULLIF(TRIM(u.pharmacy_id), ''), 'local_default')
       FROM users u
       WHERE CAST(u.id AS TEXT) = CAST(returns.user_id AS TEXT)
          OR LOWER(u.username) = LOWER(CAST(returns.user_id AS TEXT))
       LIMIT 1),
      'local_default'
    )
    WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS shifts_snapshot_pharmacy_insert
    AFTER INSERT ON shifts
    WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
    BEGIN
      UPDATE shifts SET pharmacy_id = COALESCE(
        (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
         WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
            OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
        'local_default'
      ) WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS cash_movements_snapshot_pharmacy_insert
    AFTER INSERT ON cash_movements
    WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
    BEGIN
      UPDATE cash_movements SET pharmacy_id = COALESCE(
        (SELECT NULLIF(TRIM(s.pharmacy_id), '') FROM shifts s WHERE s.id = NEW.shift_id LIMIT 1),
        (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
         WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
            OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
        'local_default'
      ) WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS daily_journals_snapshot_pharmacy_insert
    AFTER INSERT ON daily_journals
    WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
    BEGIN
      UPDATE daily_journals SET pharmacy_id = COALESCE(
        (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
         WHERE CAST(u.id AS TEXT) = CAST(NEW.created_by AS TEXT)
            OR LOWER(u.username) = LOWER(CAST(NEW.created_by AS TEXT)) LIMIT 1),
        'local_default'
      ) WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS expenses_snapshot_pharmacy_insert
    AFTER INSERT ON expenses
    WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
    BEGIN
      UPDATE expenses SET pharmacy_id = COALESCE(
        (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
         WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
            OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
        'local_default'
      ) WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS financial_notices_snapshot_pharmacy_insert
    AFTER INSERT ON financial_notices
    WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
    BEGIN
      UPDATE financial_notices SET pharmacy_id = COALESCE(
        (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
         WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
            OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
        'local_default'
      ) WHERE id = NEW.id;
    END;
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_returns_pharmacy_created ON returns(pharmacy_id, created_at)');
  db.exec(`
    UPDATE inventory
    SET medium_to_small = COALESCE((
      SELECT NULLIF(md.medium_to_small, 0)
      FROM master_drugs md
      WHERE md.id = inventory.drug_id
    ), 1);

    UPDATE purchase_invoice_items
    SET medium_to_small = COALESCE((
      SELECT NULLIF(md.medium_to_small, 0)
      FROM master_drugs md
      WHERE md.id = purchase_invoice_items.drug_id
    ), 1);

    UPDATE sales_items
    SET large_to_medium = COALESCE((
          SELECT NULLIF(i.strips_per_box, 0)
          FROM inventory i
          WHERE i.id = sales_items.inventory_id
        ), (
          SELECT NULLIF(md.large_to_medium, 0)
          FROM master_drugs md
          WHERE md.id = sales_items.drug_id
        ), 1),
        medium_to_small = COALESCE((
          SELECT NULLIF(i.medium_to_small, 0)
          FROM inventory i
          WHERE i.id = sales_items.inventory_id
        ), (
          SELECT NULLIF(md.medium_to_small, 0)
          FROM master_drugs md
          WHERE md.id = sales_items.drug_id
        ), 1);
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS shortages_set_created_at
    AFTER INSERT ON shortages
    WHEN NEW.created_at IS NULL
    BEGIN
      UPDATE shortages SET created_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END
  `);
}

function seedBaselineEntities(db: Database.Database) {
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name, is_active)
    VALUES
      ('admin', 'admin', 'hash', 'owner', 'مدير النظام', 1),
      ('pharmacist1', 'pharmacist1', 'hash', 'pharmacist', 'دكتور الصيدلية', 1);

    INSERT OR IGNORE INTO suppliers (id, name_ar, balance)
    VALUES (1, 'شركة الأدوية المتحدة', 0);

    INSERT OR IGNORE INTO patients (id, full_name, credit_limit)
    VALUES
      ('cash', 'عميل نقدي', 0),
      ('patient-1', 'أحمد محمود', 500);

    INSERT OR IGNORE INTO accounts (id, code, name_ar, type, balance, is_group)
    VALUES
      (1, '1.1.1', 'الصندوق (الخزينة النقدية)', 'asset', 0, 0),
      (2, '1.1.2', 'البنك', 'asset', 0, 0),
      (3, '1.1.3', 'الخزينة الرئيسية (العهد)', 'asset', 0, 0),
      (4, '1.2.1', 'المخزون', 'asset', 0, 0),
      (5, '2.1.1', 'الموردين', 'liability', 0, 0),
      (6, '4.1.1', 'المبيعات', 'revenue', 0, 0),
      (7, '4.1.2', 'مردودات المبيعات', 'revenue', 0, 0),
      (8, '5.1.1', 'تكلفة البضاعة المباعة', 'expense', 0, 0),
      (9, '5.3.1', 'عجز النقدية', 'expense', 0, 0),
      (10, '4.3.1', 'زيادة النقدية', 'revenue', 0, 0);

    INSERT OR IGNORE INTO banks (id, name_ar, name_en, account_number, current_balance)
    VALUES (1, 'بنك التجاري الدولي', 'CIB Bank', '123456', 5000);

    INSERT OR IGNORE INTO master_drugs (
      id, trade_name, trade_name_en, reorder_point, default_purchase_qty,
      large_to_medium, medium_to_small, medium_unit, small_unit, barcode
    ) VALUES
      (5001, 'بانادول اكسترا', 'Panadol Extra', 10, 20, 2, 12, 'شريط', 'قرص', '62210001'),
      (5002, 'كونجستال اقراص', 'Congestal Tab', 5, 10, 2, 10, 'شريط', 'قرص', '62210002');
  `);
}

describe('Cross-computer consistency across fresh install and update', () => {
  beforeEach(() => {
    mockId = 0;
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
  });

  afterEach(() => {
    if (mockDb) mockDb.close();
  });

  it('behaves identically on a FRESH installation', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    // 1. Open shift
    const openShiftRes = await openShiftAction({ starting_cash_amount: 100 });
    expect(openShiftRes.success).toBe(true);
    const shift = (await getCurrentShiftAction()).data;
    expect(shift).toBeDefined();
    expect(shift?.status).toBe('open');

    // 2. Shortage & Low Stock Alert for Drug 5001 (initially 0 stock, reorder=10)
    await addToShortagesAction({ drug_id: 5001, qty: 15 });
    const shortagesBefore = (await getShortagesAction()).data || [];
    expect(shortagesBefore.some((s: any) => s.drug_id === 5001)).toBe(true);

    const lowStockBefore = await getLowStockAction(10);
    expect(lowStockBefore.data?.some((d: any) => d.id === 5001)).toBe(true);

    // 3. Purchase invoice: buy 20 boxes of 5001 (exceeds reorder_point)
    const purchaseRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-FRESH-01',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'completed',
      cart: [
        {
          id: 5001,
          quantity: 20,
          cost_price: 30,
          selling_price: 40,
          expiry_date: '2029-12-31',
          strips_per_box: 2,
          barcode: '62210001',
        },
      ],
    });
    expect(purchaseRes.success).toBe(true);

    // 4. Verify Shortages marked received & removed from active list
    const shortagesAfter = (await getShortagesAction()).data || [];
    expect(shortagesAfter.some((s: any) => s.drug_id === 5001)).toBe(false);
    const shortageRow = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5001').get() as any;
    expect(shortageRow.status).toBe('received');

    // 5. Verify Low Stock Alert cleared (stock is 20 > 10)
    const lowStockAfter = await getLowStockAction(10);
    expect(lowStockAfter.data?.some((d: any) => d.id === 5001)).toBe(false);

    // 6. Sell 2 boxes via POS
    const invRow = mockDb.prepare('SELECT id FROM inventory WHERE drug_id = 5001').get() as any;
    const checkoutRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5001,
          inventory_id: invRow.id,
          quantity_sold: 2,
          unit_price: 40,
          selected_unit: 'large',
        },
      ],
      payment_method: 'cash',
      total_discount: 0,
    });
    expect(checkoutRes.success).toBe(true);

    // Verify stock is now 18
    const stockAfterSale = mockDb.prepare('SELECT quantity FROM inventory WHERE drug_id = 5001').get() as any;
    expect(stockAfterSale.quantity).toBe(18);

    // 7. Perform Sales Return (1 box) associated with the current shift
    const saleId = checkoutRes.data?.sale_id;
    expect(saleId).toBeDefined();
    const soldItem = mockDb.prepare('SELECT id FROM sales_items WHERE invoice_id = ?').get(saleId) as any;
    expect(soldItem).toBeDefined();

    const returnRes = await createReturnAction({
      invoice_id: saleId,
      shift_id: shift!.id,
      items: [
        {
          sale_item_id: soldItem.id,
          drug_name: 'بانادول اكسترا',
          inventory_id: invRow.id,
          quantity: 1,
          unit_price: 40,
          unit: 'large',
        },
      ],
      refund_method: 'cash',
      reason: 'طلب العميل إرجاع علبة',
    });
    expect(returnRes.success).toBe(true);

    // Verify stock is now 19
    const stockAfterReturn = mockDb.prepare('SELECT quantity FROM inventory WHERE drug_id = 5001').get() as any;
    expect(stockAfterReturn.quantity).toBe(19);

    // 8. Handover closes the old shift and opens a shared replacement.
    const handoverRes = await processHandoverAction({
      shiftId: shift!.id,
      actualCash: 140, // 100 starting + 80 sale - 40 refund = 140 expected.
      transferAmount: 100,
      transferTargetId: 'vault',
      transferTargetType: 'treasury',
      receiverUsername: 'admin',
      receiverPasswordHash: 'hash',
    });
    expect(handoverRes.success).toBe(true);
    expect(handoverRes.difference).toBe(0);
    expect(handoverRes.remainingCash).toBe(40);

    const permanentShift = mockDb.prepare('SELECT * FROM shifts WHERE id = ?').get(shift!.id) as any;
    expect(permanentShift.status).toBe('closed');
    expect(handoverRes.newShiftId).not.toBe(shift!.id);
    expect(mockDb.prepare("SELECT starting_cash FROM shifts WHERE id=? AND status='open'").get(handoverRes.newShiftId)).toEqual({ starting_cash:40 });
    expect(permanentShift.actual_cash).toBe(140);
    expect(permanentShift.cash_difference).toBe(0);

    // 9. Financial Module Full Dynamic Operations on Fresh Install
    const addBankRes = await addBankAction({
      name_ar: 'بنك مصر',
      name_en: 'Banque Misr',
      account_number: '987654321',
      branch: 'الفرع الرئيسي',
      current_balance: 10000,
    });
    expect(addBankRes.success).toBe(true);
    const banks = (await getBanksAction()).data || [];
    expect(banks.some((b: any) => b.name_ar === 'بنك مصر')).toBe(true);

    const addCardRes = await addCardAction({
      name_ar: 'ماكينة فوري كاشير 1',
      bank_id: Number(addBankRes.id),
      commission_pct: 1.5,
      current_balance: 0,
    });
    expect(addCardRes.success).toBe(true);
    const cards = (await getCardsAction()).data || [];
    expect(cards.some((c: any) => c.name_ar === 'ماكينة فوري كاشير 1')).toBe(true);

    const addPosRes = await addPointOfSaleAction({
      name_ar: 'كاشير الصالة 1',
      name_en: 'POS-01',
      location: 'الصالة الرئيسية',
      computer_name: 'PC-01',
    });
    expect(addPosRes.success).toBe(true);
    const posList = (await getPointsOfSaleAction()).data || [];
    expect(posList.some((p: any) => p.name_ar === 'كاشير الصالة 1')).toBe(true);

    const addPaperRes = await addPaperAction({
      type: 'check',
      direction: 'in',
      paper_number: 'CHK-9988',
      bank_id: Number(addBankRes.id),
      amount: 1500,
      due_date: '2026-09-15',
      target_name: 'صيدلية الأمل',
    });
    expect(addPaperRes.success).toBe(true);
    const paperId = addPaperRes.id!;
    const papers = (await getPapersAction()).data || [];
    expect(papers.some((p: any) => p.id === paperId)).toBe(true);

    const cashPaperRes = await updatePaperStatusAction(paperId, 'cashed', '2026-09-01');
    expect(cashPaperRes.success).toBe(true);
    const cashedPaper = mockDb.prepare('SELECT status FROM commercial_papers WHERE id = ?').get(paperId) as any;
    expect(cashedPaper.status).toBe('cashed');
    expect(mockDb.prepare("SELECT source_type, target_name FROM cash_movements WHERE category = 'collection' AND target_name = ?").get(paperId)).toMatchObject({
      source_type: 'commercial_paper',
      target_name: paperId,
    });
    expect(await updatePaperStatusAction(paperId, 'bounced')).toMatchObject({
      success: false,
      error: expect.stringContaining('قيد عكسي'),
    });
    expect((mockDb.prepare('SELECT status FROM commercial_papers WHERE id = ?').get(paperId) as any).status).toBe('cashed');

    const journalRes = await createManualJournalAction({
      date: '2026-09-01',
      description: 'تسوية نقدية يدوية',
      entries: [
        { account_id: 6, type: 'debit', amount: 500, notes: 'زيادة نقدية' },
        { account_id: 9, type: 'credit', amount: 500, notes: 'إيراد تسوية' },
      ],
    });
    expect(journalRes.success).toBe(true);
    const journals = (await getJournalsAction()).data || [];
    expect(journals.some((j: any) => j.description === 'تسوية نقدية يدوية')).toBe(true);
  });

  it.each(['v0.2.92', 'v0.2.93'])('behaves identically when updating from %s', async () => {
    mockDb = new Database(':memory:');
    applyV0292OrV0293Migrations(mockDb);
    mockDb.exec(`
      INSERT INTO users (id, username, password_hash, role, full_name, is_active)
      VALUES ('legacy-unit-user', 'legacy-unit-user', 'hash', 'owner', 'Legacy Unit User', 1);
      INSERT INTO suppliers (id, name_ar, balance)
      VALUES (99, 'Legacy Unit Supplier', 0);
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, official_price,
        large_to_medium, medium_to_small, medium_unit, small_unit
      ) VALUES (
        5999, 'وحدة قديمة', 'Legacy Unit Drug', 120,
        12, 10, 'strip', 'tablet'
      );
      INSERT INTO inventory (
        id, drug_id, quantity, local_selling_price, cost_price,
        expiry_date, strips_per_box
      ) VALUES (
        'legacy-unit-lot', 5999, 1, 120, 60,
        '2099-12-31', 12
      );
      INSERT INTO purchase_invoices (
        id, supplier_id, user_id, invoice_number, invoice_date,
        payment_method, status, total_amount
      ) VALUES (
        'legacy-unit-purchase', 99, 'legacy-unit-user', 'LEGACY-UNIT-P',
        '2026-08-01', 'credit', 'completed', 60
      );
      INSERT INTO purchase_invoice_items (
        invoice_id, drug_id, quantity, cost_price, selling_price,
        strips_per_box, inventory_id
      ) VALUES (
        'legacy-unit-purchase', 5999, 1, 60, 120,
        12, 'legacy-unit-lot'
      );
      INSERT INTO sales_invoices (
        id, user_id, total_amount, payment_method, status
      ) VALUES (
        'legacy-unit-sale', 'legacy-unit-user', 10, 'cash', 'completed'
      );
      INSERT INTO sales_items (
        invoice_id, inventory_id, drug_id, quantity_sold,
        unit_price, unit, cost_price
      ) VALUES (
        'legacy-unit-sale', 'legacy-unit-lot', 5999, 10,
        1, 'small', 60
      );
    `);

    for (const file of [
      '018_unit_conversion_snapshots.sql',
      '019_shift_pharmacy_scope.sql',
      '020_daily_snapshot_pharmacy_scope.sql',
      '021_returns_pharmacy_scope.sql',
      '022_finance_pharmacy_scope.sql',
      '023_shift_immutable_scope.sql',
      '024_commercial_papers_pharmacy_scope.sql',
      '025_sales_item_discount_snapshot.sql',
      '026_sales_loyalty_redemption_snapshot.sql',
      '027_drug_catalog_reconciliation.sql',
      '028_finance_definitions_pharmacy_scope.sql',
    ]) {
      mockDb.exec(readFileSync(`src-tauri/migrations/${file}`, 'utf8'));
    }

    // Simulate current local.ts compatibility repair on a real immediately-previous schema.
    applyLocalSchemaRepairs(mockDb);
    expect(mockDb.prepare(
      'SELECT medium_to_small FROM inventory WHERE id = ?'
    ).get('legacy-unit-lot')).toEqual({ medium_to_small: 10 });
    expect(mockDb.prepare(
      'SELECT medium_to_small FROM purchase_invoice_items WHERE invoice_id = ?'
    ).get('legacy-unit-purchase')).toEqual({ medium_to_small: 10 });
    expect(mockDb.prepare(
      'SELECT large_to_medium, medium_to_small FROM sales_items WHERE invoice_id = ?'
    ).get('legacy-unit-sale')).toEqual({ large_to_medium: 12, medium_to_small: 10 });
    mockDb.exec(`
      UPDATE master_drugs SET large_to_medium = 77, medium_to_small = 99 WHERE id = 5999;
      UPDATE inventory SET strips_per_box = 77, medium_to_small = 99 WHERE id = 'legacy-unit-lot';
    `);
    seedBaselineEntities(mockDb);

    // 1. Open shift
    const openShiftRes = await openShiftAction({ starting_cash_amount: 100 });
    expect(openShiftRes.success).toBe(true);
    const shift = (await getCurrentShiftAction()).data;
    expect(shift).toBeDefined();
    expect(shift?.status).toBe('open');

    const historicalSaleItem = mockDb.prepare(
      'SELECT id FROM sales_items WHERE invoice_id = ?'
    ).get('legacy-unit-sale') as any;
    const stockBeforeHistoricalReturn = Number((mockDb.prepare(
      'SELECT quantity FROM inventory WHERE id = ?'
    ).get('legacy-unit-lot') as any).quantity);
    expect(await createReturnAction({
      invoice_id: 'legacy-unit-sale',
      shift_id: shift!.id,
      refund_method: 'cash',
      reason: 'upgrade historical unit snapshot',
      items: [{
        sale_item_id: Number(historicalSaleItem.id),
        inventory_id: 'legacy-unit-lot',
        drug_name: 'Legacy Unit Drug',
        quantity: 10,
        unit_price: 999,
        unit: 'small',
      }],
    })).toMatchObject({ success: true, totalRefund: 10 });
    expect(Number((mockDb.prepare(
      'SELECT quantity FROM inventory WHERE id = ?'
    ).get('legacy-unit-lot') as any).quantity)).toBeCloseTo(
      stockBeforeHistoricalReturn + 10 / (12 * 10),
      8
    );

    // 2. Shortage & Low Stock Alert for Drug 5002 (reorder=5, stock=0)
    await addToShortagesAction({ drug_id: 5002, qty: 10 });
    const shortagesBefore = (await getShortagesAction()).data || [];
    expect(shortagesBefore.some((s: any) => s.drug_id === 5002)).toBe(true);

    // 3. Purchase invoice on updated schema
    const purchaseRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-UPDATE-01',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'completed',
      cart: [
        {
          id: 5002,
          quantity: 10,
          cost_price: 15,
          selling_price: 20,
          expiry_date: '2029-12-31',
          strips_per_box: 2,
          barcode: '62210002',
        },
      ],
    });
    expect(purchaseRes.success).toBe(true);

    // 4. Verify Shortages updated to 'received' on update installation
    const shortagesAfter = (await getShortagesAction()).data || [];
    expect(shortagesAfter.some((s: any) => s.drug_id === 5002)).toBe(false);
    const shortageRow = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5002').get() as any;
    expect(shortageRow.status).toBe('received');

    // 5. Verify Low Stock Alert cleared (stock is 10 > 5)
    const lowStockAfter = await getLowStockAction(5);
    expect(lowStockAfter.data?.some((d: any) => d.id === 5002)).toBe(false);

    // 6. Sell 1 box via POS
    const invRow = mockDb.prepare('SELECT id FROM inventory WHERE drug_id = 5002').get() as any;
    const checkoutRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5002,
          inventory_id: invRow.id,
          quantity_sold: 1,
          unit_price: 20,
          selected_unit: 'large',
        },
      ],
      payment_method: 'cash',
      total_discount: 0,
    });
    expect(checkoutRes.success).toBe(true);

    // 7. Close Shift with Handover
    const handoverRes = await processHandoverAction({
      shiftId: shift!.id,
      actualCash: 110, // 100 starting + 20 sale - 10 historical cash refund
      transferAmount: 70,
      transferTargetId: 'vault',
      transferTargetType: 'treasury',
      receiverUsername: 'admin',
      receiverPasswordHash: 'hash',
    });
    expect(handoverRes.success).toBe(true);
    expect(handoverRes.difference).toBe(0);
    expect(handoverRes.remainingCash).toBe(40);

    // 8. Financial Module Full Dynamic Operations on Update Install
    const addBankRes = await addBankAction({
      name_ar: 'بنك مصر (تحديث)',
      name_en: 'Banque Misr Updated',
      account_number: '11223344',
      branch: 'فرع الدقي',
      current_balance: 7500,
    });
    expect(addBankRes.success).toBe(true);
    const banks = (await getBanksAction()).data || [];
    expect(banks.some((b: any) => b.name_ar === 'بنك مصر (تحديث)')).toBe(true);

    const addCardRes = await addCardAction({
      name_ar: 'ماكينة بنك مصر كاشير 2',
      bank_id: Number(addBankRes.id),
      commission_pct: 1.0,
      current_balance: 0,
    });
    expect(addCardRes.success).toBe(true);
    const cards = (await getCardsAction()).data || [];
    expect(cards.some((c: any) => c.name_ar === 'ماكينة بنك مصر كاشير 2')).toBe(true);

    const addPosRes = await addPointOfSaleAction({
      name_ar: 'كاشير الفرع 2',
      name_en: 'POS-02',
      location: 'الفرع الإضافي',
      computer_name: 'PC-02',
    });
    expect(addPosRes.success).toBe(true);
    const posList = (await getPointsOfSaleAction()).data || [];
    expect(posList.some((p: any) => p.name_ar === 'كاشير الفرع 2')).toBe(true);

    const addPaperRes = await addPaperAction({
      type: 'promissory_note',
      direction: 'out',
      paper_number: 'NOTE-7766',
      bank_id: Number(addBankRes.id),
      amount: 3000,
      due_date: '2026-10-01',
      target_name: 'شركة توزيع الأدوية',
    });
    expect(addPaperRes.success).toBe(true);
    const paperId = addPaperRes.id!;
    const papers = (await getPapersAction()).data || [];
    expect(papers.some((p: any) => p.id === paperId)).toBe(true);

    const cashPaperRes = await updatePaperStatusAction(paperId, 'cashed', '2026-09-01');
    expect(cashPaperRes.success).toBe(true);
    const cashedPaper = mockDb.prepare('SELECT status FROM commercial_papers WHERE id = ?').get(paperId) as any;
    expect(cashedPaper.status).toBe('cashed');

    const journalRes = await createManualJournalAction({
      date: '2026-09-01',
      description: 'تسوية رصيد بنكي في التحديث',
      entries: [
        { account_id: 8, type: 'debit', amount: 1000, notes: 'إيداع بنكي' },
        { account_id: 6, type: 'credit', amount: 1000, notes: 'صرف من الخزينة' },
      ],
    });
    expect(journalRes.success).toBe(true);
    const journals = (await getJournalsAction()).data || [];
    expect(journals.some((j: any) => j.description === 'تسوية رصيد بنكي في التحديث')).toBe(true);
  });

  it('keeps v0.2.91 historical handover and finance rows on their startup-backfilled pharmacy', async () => {
    mockDb = new Database(':memory:');
    applyV0292OrV0293Migrations(mockDb); // v0.2.91 and v0.2.92/93 share migrations 001-017.
    mockDb.exec(`
      INSERT INTO users (id, username, password_hash, role, full_name, pharmacy_id, is_active)
      VALUES
        ('legacy-finance-actor', 'legacy-finance-actor', 'hash', 'admin', 'Legacy Actor', 'ph-1', 1),
        ('ph1-viewer', 'ph1-viewer', 'hash', 'owner', 'PH1 Viewer', 'ph-1', 1),
        ('legacy-default-actor', 'legacy-default-actor', 'hash', 'admin', 'Legacy Default Actor', 'local_default', 1),
        ('default-viewer', 'default-viewer', 'hash', 'owner', 'Default Viewer', 'local_default', 1);
      INSERT INTO shifts (id, user_id, starting_cash, status)
      VALUES
        ('legacy-finance-shift', 'legacy-finance-actor', 100, 'closed'),
        ('legacy-default-shift', 'legacy-default-actor', 50, 'closed');
      INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, notes, date)
      VALUES
        ('legacy-finance-cash', 'legacy-finance-actor', 'legacy-finance-shift', 'receipt', 'pharmacy', 11, 'legacy receipt', date('now','localtime')),
        ('legacy-default-cash', 'legacy-default-actor', 'legacy-default-shift', 'receipt', 'pharmacy', 7, 'default receipt', date('now','localtime'));
      INSERT INTO daily_journals (id, date, description, created_by, total_amount)
      VALUES
        ('legacy-finance-journal', date('now','localtime'), 'legacy journal', 'legacy-finance-actor', 11),
        ('legacy-default-journal', date('now','localtime'), 'default journal', 'legacy-default-actor', 7);
      INSERT INTO expenses (id, user_id, category, amount, description, date)
      VALUES
        ('legacy-finance-expense', 'legacy-finance-actor', 'rent', 4, 'legacy expense', date('now','localtime')),
        ('legacy-default-expense', 'legacy-default-actor', 'rent', 2, 'default expense', date('now','localtime'));
      INSERT INTO financial_notices (id, user_id, target_type, type, amount, reason, date)
      VALUES
        ('legacy-finance-notice', 'legacy-finance-actor', 'pharmacy', 'debit', 3, 'legacy notice', date('now','localtime')),
        ('legacy-default-notice', 'legacy-default-actor', 'pharmacy', 'debit', 1, 'default notice', date('now','localtime'));
    `);

    applyLocalSchemaRepairs(mockDb);
    expect(mockDb.prepare(`
      SELECT
        (SELECT pharmacy_id FROM shifts WHERE id='legacy-finance-shift') AS shift_scope,
        (SELECT pharmacy_id FROM cash_movements WHERE id='legacy-finance-cash') AS cash_scope,
        (SELECT pharmacy_id FROM daily_journals WHERE id='legacy-finance-journal') AS journal_scope,
        (SELECT pharmacy_id FROM expenses WHERE id='legacy-finance-expense') AS expense_scope,
        (SELECT pharmacy_id FROM financial_notices WHERE id='legacy-finance-notice') AS notice_scope
    `).get()).toEqual({
      shift_scope: 'ph-1',
      cash_scope: 'ph-1',
      journal_scope: 'ph-1',
      expense_scope: 'ph-1',
      notice_scope: 'ph-1',
    });
    expect(mockDb.prepare(`
      SELECT
        (SELECT pharmacy_id FROM shifts WHERE id='legacy-default-shift') AS shift_scope,
        (SELECT pharmacy_id FROM cash_movements WHERE id='legacy-default-cash') AS cash_scope,
        (SELECT pharmacy_id FROM daily_journals WHERE id='legacy-default-journal') AS journal_scope,
        (SELECT pharmacy_id FROM expenses WHERE id='legacy-default-expense') AS expense_scope,
        (SELECT pharmacy_id FROM financial_notices WHERE id='legacy-default-notice') AS notice_scope
    `).get()).toEqual({
      shift_scope: 'local_default',
      cash_scope: 'local_default',
      journal_scope: 'local_default',
      expense_scope: 'local_default',
      notice_scope: 'local_default',
    });

    mockDb.prepare("UPDATE users SET pharmacy_id='ph-2' WHERE id='legacy-finance-actor'").run();
    mockSession = { id: 'ph1-viewer', role: 'owner', pharmacy_id: 'ph-1' };
    expect(await getHandoverDetailsAction('legacy-finance-shift')).toMatchObject({ success: true });
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).toContain('legacy-finance-cash');
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).not.toContain('legacy-default-cash');
    expect((await getJournalsAction()).data?.map((row: any) => row.id)).toContain('legacy-finance-journal');
    expect((await getFinancialNoticesAction()).data?.map((row: any) => row.id)).toContain('legacy-finance-notice');
    expect(await getTreasuryDashboardAction()).toMatchObject({
      success: true,
      data: { todayReceipts: 11, todayExpenses: 4 },
    });

    mockSession = { id: 'default-viewer', role: 'owner', pharmacy_id: 'local_default' };
    expect(await getHandoverDetailsAction('legacy-default-shift')).toMatchObject({ success: true });
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).toContain('legacy-default-cash');
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).not.toContain('legacy-finance-cash');
    expect((await getJournalsAction()).data?.map((row: any) => row.id)).toContain('legacy-default-journal');
    expect((await getFinancialNoticesAction()).data?.map((row: any) => row.id)).toContain('legacy-default-notice');

    mockSession = { id: 'legacy-finance-actor', role: 'owner', pharmacy_id: 'ph-2' };
    expect(await getHandoverDetailsAction('legacy-finance-shift')).toMatchObject({ success: false });
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).not.toContain('legacy-finance-cash');
    expect((await getJournalsAction()).data?.map((row: any) => row.id)).not.toContain('legacy-finance-journal');
    expect((await getFinancialNoticesAction()).data?.map((row: any) => row.id)).not.toContain('legacy-finance-notice');
  });

  it('tests advanced feature options: purchase draft completion, edit, returns, and next-shift handover', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    await openShiftAction({ starting_cash_amount: 50 });
    const shift = (await getCurrentShiftAction()).data;

    // A. Purchase Draft Creation -> Complete Draft
    await addToShortagesAction({ drug_id: 5001, qty: 10 });
    const draftRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-DRAFT-01',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'draft',
      cart: [
        {
          id: 5001,
          quantity: 10,
          cost_price: 25,
          selling_price: 35,
          expiry_date: '2028-12-31',
          strips_per_box: 2,
        },
      ],
    });
    expect(draftRes.success).toBe(true);
    // While draft, shortage is still pending
    const draftShortage = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5001').get() as any;
    expect(draftShortage.status).toBe('pending');

    // Complete the draft
    const completeRes = await completePurchaseInvoiceAction(draftRes.id!);
    expect(completeRes.success).toBe(true);
    const completedShortage = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5001').get() as any;
    // Stock exactly at the reorder point is still low stock, so the shortage remains active.
    expect(completedShortage.status).toBe('pending');

    // B. Unit options: sell 1 strip (medium unit) instead of whole box
    const invRow = mockDb.prepare('SELECT id, quantity FROM inventory WHERE drug_id = 5001').get() as any;
    expect(invRow.quantity).toBe(10);

    const stripSaleRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5001,
          inventory_id: invRow.id,
          quantity_sold: 1,
          unit_price: 17.5,
          selected_unit: 'medium', // 1 strip from 2 strips/box = 0.5 box
        },
      ],
      payment_method: 'cash',
      total_discount: 0,
    });
    expect(stripSaleRes.success).toBe(true);

    const invAfterStrip = mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get(invRow.id) as any;
    expect(invAfterStrip.quantity).toBeCloseTo(9.5, 4); // Exactly 9.5 boxes left!

    // C. Credit sale option: sell to patient on account
    const creditSaleRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5001,
          inventory_id: invRow.id,
          quantity_sold: 1,
          unit_price: 35,
          selected_unit: 'large',
        },
      ],
      patient_id: 'patient-1',
      payment_method: 'credit',
      total_discount: 0,
    });
    expect(creditSaleRes.success).toBe(true);

    // Sales invoice recorded with credit payment method
    const creditSale = mockDb.prepare("SELECT total_amount, payment_method FROM sales_invoices WHERE patient_id = 'patient-1'").get() as any;
    expect(creditSale.total_amount).toBe(35);
    expect(creditSale.payment_method).toBe('credit');

    // D. Old auto-open requests are idempotent under the permanent-session model.
    // Cash in drawer = 50 starting + 17.5 strip sale (cash) = 67.5 (credit sale is 0 cash).
    // Transfer 50 to treasury, remaining in drawer = 17.5 for next shift.
    const nextShiftHandover = await processHandoverAction({
      shiftId: shift!.id,
      actualCash: 67.5,
      transferAmount: 50,
      transferTargetId: 'vault',
      transferTargetType: 'treasury',
      receiverUsername: 'pharmacist1',
      receiverPasswordHash: 'hash',
      autoOpenNewShift: true,
    });
    expect(nextShiftHandover.success).toBe(true);
    expect(nextShiftHandover.difference).toBe(0);
    expect(nextShiftHandover.remainingCash).toBe(17.5);

    // Verify the same session remains open and carries 17.5 as its computed balance.
    const nextShift = mockDb.prepare("SELECT * FROM shifts WHERE user_id = 'admin' AND status = 'open'").get() as any;
    expect(nextShift).toBeDefined();
    expect(nextShift.starting_cash).toBe(17.5);
    expect(nextShift.id).not.toBe(shift!.id);
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM shifts WHERE user_id = 'admin'").get() as any).total).toBe(2);
  });

  it('normalizes timestamps consistently across all computer timezones and string formats', () => {
    // 1. SQLite standard format: 'YYYY-MM-DD HH:mm:ss'
    const rows1 = [{ id: 1, created_at: '2026-08-30 15:30:00', total_amount: 100 }];
    const norm1 = normalizeDatabaseTimestamps(rows1);
    expect(norm1[0].created_at).toBe('2026-08-30T15:30:00Z');

    // 2. Already normalized ISO string with Z
    const rows2 = [{ id: 2, created_at: '2026-08-30T15:30:00Z' }];
    const norm2 = normalizeDatabaseTimestamps(rows2);
    expect(norm2[0].created_at).toBe('2026-08-30T15:30:00Z');

    // 3. Null or undefined timestamps
    const rows3 = [{ id: 3, created_at: null, updated_at: undefined }];
    const norm3 = normalizeDatabaseTimestamps(rows3);
    expect(norm3[0].created_at).toBeNull();
    expect(norm3[0].updated_at).toBeUndefined();

    // 4. Verify JavaScript Date parses the normalized timestamp to accurate UTC time
    const parsedDate = new Date(norm1[0].created_at);
    expect(isNaN(parsedDate.getTime())).toBe(false);
    expect(parsedDate.getUTCFullYear()).toBe(2026);
    expect(parsedDate.getUTCMonth()).toBe(7); // 0-indexed August
    expect(parsedDate.getUTCDate()).toBe(30);
    expect(parsedDate.getUTCHours()).toBe(15);
    expect(parsedDate.getUTCMinutes()).toBe(30);
  });

  it('merges legacy per-user open shifts into one shared shift during update', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
      legacyDb.exec(`
        INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name)
        VALUES ('legacy-a', 'legacy_a', 'hash', 'admin', 'Legacy A'),
               ('legacy-b', 'legacy_b', 'hash', 'pharmacist', 'Legacy B');
        INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
        VALUES ('shared-oldest', 'legacy-a', '2026-08-01 08:00:00', 10, 'open'),
               ('legacy-extra', 'legacy-b', '2026-08-01 09:00:00', 20, 'open');
        INSERT INTO sales_invoices (id, user_id, shift_id, total_amount, payment_method, status)
        VALUES ('legacy-sale', 'legacy-b', 'legacy-extra', 5, 'cash', 'completed');
        INSERT INTO returns (id, invoice_id, user_id, shift_id, total_refund, refund_method, status)
        VALUES ('legacy-return', 'legacy-sale', 'legacy-b', 'legacy-extra', 1, 'cash', 'approved');
        INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date)
        VALUES ('legacy-movement', 'legacy-b', 'legacy-extra', 'receipt', 'pharmacy', 2, '2026-08-01');
      `);

      legacyDb.exec(readFileSync('src-tauri/migrations/015_shared_open_shift.sql', 'utf8'));

      expect(legacyDb.prepare("SELECT id, starting_cash FROM shifts WHERE status = 'open'").all()).toEqual([
        { id: 'shared-oldest', starting_cash: 30 },
      ]);
      expect(legacyDb.prepare("SELECT status FROM shifts WHERE id = 'legacy-extra'").get()).toEqual({ status: 'merged' });
      expect(legacyDb.prepare("SELECT shift_id FROM sales_invoices WHERE id = 'legacy-sale'").get()).toEqual({ shift_id: 'shared-oldest' });
      expect(legacyDb.prepare("SELECT shift_id FROM returns WHERE id = 'legacy-return'").get()).toEqual({ shift_id: 'shared-oldest' });
      expect(legacyDb.prepare("SELECT shift_id FROM cash_movements WHERE id = 'legacy-movement'").get()).toEqual({ shift_id: 'shared-oldest' });
      expect(() => legacyDb.prepare(`
        INSERT INTO shifts (id, user_id, starting_cash, status)
        VALUES ('duplicate-open', 'legacy-b', 0, 'open')
      `).run()).toThrow();

      legacyDb.prepare("UPDATE users SET pharmacy_id = 'ph-1' WHERE id = 'legacy-a'").run();
      legacyDb.prepare("UPDATE users SET pharmacy_id = 'ph-2' WHERE id = 'legacy-b'").run();
      legacyDb.exec(readFileSync('src-tauri/migrations/019_shift_pharmacy_scope.sql', 'utf8'));
      legacyDb.prepare(`
        INSERT INTO shifts (id, user_id, starting_cash, status)
        VALUES ('ph2-open', 'legacy-b', 0, 'open')
      `).run();
      expect(legacyDb.prepare("SELECT id FROM shifts WHERE status = 'open' ORDER BY id").all()).toEqual([
        { id: 'ph2-open' },
        { id: 'shared-oldest' },
      ]);
      expect(() => legacyDb.prepare(`
        INSERT INTO shifts (id, user_id, starting_cash, status)
        VALUES ('ph1-duplicate', 'legacy-a', 0, 'open')
      `).run()).toThrow();
    } finally {
      legacyDb.close();
    }
  });

  it('upgrades date-only financial snapshots without losing the legacy row or cross-pharmacy independence', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE daily_financial_snapshots (
          date TEXT PRIMARY KEY,
          total_sales REAL DEFAULT 0,
          total_returns REAL DEFAULT 0,
          total_cash_movements REAL DEFAULT 0,
          net_profit REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO daily_financial_snapshots
          (date, total_sales, total_returns, total_cash_movements, net_profit)
        VALUES ('2026-09-19', 100, 10, 5, 95);
      `);

      legacyDb.exec(readFileSync('src-tauri/migrations/020_daily_snapshot_pharmacy_scope.sql', 'utf8'));

      expect(legacyDb.prepare(`
        SELECT date, pharmacy_id, total_sales, total_returns, total_cash_movements, net_profit
        FROM daily_financial_snapshots
      `).all()).toEqual([{
        date: '2026-09-19',
        pharmacy_id: 'local_default',
        total_sales: 100,
        total_returns: 10,
        total_cash_movements: 5,
        net_profit: 95,
      }]);
      legacyDb.prepare(`
        INSERT INTO daily_financial_snapshots (date, pharmacy_id, total_sales)
        VALUES ('2026-09-19', 'ph-2', 70)
      `).run();
      expect((legacyDb.prepare(`
        SELECT COUNT(*) AS total
        FROM daily_financial_snapshots
        WHERE date = '2026-09-19'
      `).get() as any).total).toBe(2);
      expect(() => legacyDb.prepare(`
        INSERT INTO daily_financial_snapshots (date, pharmacy_id, total_sales)
        VALUES ('2026-09-19', 'local_default', 999)
      `).run()).toThrow();
    } finally {
      legacyDb.close();
    }
  });

  it('snapshots return ownership so later staff moves do not reassign history', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT,
          role TEXT,
          pharmacy_id TEXT
        );
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          pharmacy_id TEXT
        );
        CREATE TABLE returns (
          id TEXT PRIMARY KEY,
          invoice_id TEXT,
          user_id TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE shortages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_id INTEGER,
          requested_quantity REAL,
          status TEXT,
          created_at TEXT
        );
        CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
        CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, strips_per_box INTEGER DEFAULT 1);
        CREATE TABLE sales_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
        CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, start_time TEXT, end_time TEXT);
        CREATE TABLE cash_movements (id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, date TEXT);
        CREATE TABLE daily_journals (id TEXT PRIMARY KEY, created_by TEXT, date TEXT);
        CREATE TABLE expenses (id TEXT PRIMARY KEY, user_id TEXT, date TEXT);
        CREATE TABLE financial_notices (id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);
        CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER, medium_to_small INTEGER);

        INSERT INTO users VALUES
          ('u1', 'u1', 'admin', 'ph-1'),
          ('u2', 'u2', 'admin', 'ph-2');
        INSERT INTO sales_invoices VALUES
          ('s1', 'u1', 'ph-1');
        INSERT INTO returns (id, invoice_id, user_id) VALUES
          ('invoice-return', 's1', 'u1'),
          ('general-return', NULL, 'u1');
      `);

      legacyDb.exec(readFileSync('src-tauri/migrations/021_returns_pharmacy_scope.sql', 'utf8'));
      applyLocalSchemaRepairs(legacyDb);

      expect(legacyDb.prepare(
        'SELECT id, pharmacy_id FROM returns ORDER BY id'
      ).all()).toEqual([
        { id: 'general-return', pharmacy_id: 'ph-1' },
        { id: 'invoice-return', pharmacy_id: 'ph-1' },
      ]);

      legacyDb.prepare("UPDATE users SET pharmacy_id = 'ph-2' WHERE id = 'u1'").run();
      expect(legacyDb.prepare(
        'SELECT id, pharmacy_id FROM returns ORDER BY id'
      ).all()).toEqual([
        { id: 'general-return', pharmacy_id: 'ph-1' },
        { id: 'invoice-return', pharmacy_id: 'ph-1' },
      ]);
    } finally {
      legacyDb.close();
    }
  });

  it('backfills historical cash expenses without duplicating already linked expense records', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
      legacyDb.exec(`
        INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name)
        VALUES ('expense-user', 'expense_user', 'hash', 'admin', 'Expense User');
        INSERT INTO expenses (id, user_id, category, amount, description, date)
        VALUES ('already-linked', 'expense-user', 'أدوات مكتبية', 30, 'ورق', '2026-08-31');
        INSERT INTO cash_movements (id, user_id, type, category, sub_category, amount, notes, date)
        VALUES
          ('linked-movement', 'expense-user', 'disbursement', 'operating_expenses', 'أدوات مكتبية', 30, 'ورق', '2026-08-31'),
          ('legacy-rent', 'expense-user', 'disbursement', 'rent', NULL, 100, 'إيجار', '2026-08-31'),
          ('owner-draw', 'expense-user', 'disbursement', 'personal', NULL, 50, 'مسحوبات', '2026-08-31');
      `);

      const migration = readFileSync('src-tauri/migrations/016_financial_expense_wiring.sql', 'utf8');
      legacyDb.exec(migration);
      legacyDb.exec(migration);

      expect(legacyDb.prepare(`
        SELECT category, amount, description
        FROM expenses
        ORDER BY amount
      `).all()).toEqual([
        { category: 'أدوات مكتبية', amount: 30, description: 'ورق' },
        { category: 'rent', amount: 100, description: 'إيجار' },
      ]);
    } finally {
      legacyDb.close();
    }
  });

  it('keeps separate trial-balance mappings for every bank, POS, and expense entity', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    expect((await saveTrialBalanceSettingAction({ category: 'bank', target_id: '1', target_name: 'بنك 1', account_id: 6 })).success).toBe(true);
    expect((await saveTrialBalanceSettingAction({ category: 'bank', target_id: '2', target_name: 'بنك 2', account_id: 7 })).success).toBe(true);

    const mappings = mockDb.prepare(`
      SELECT category, target_id, account_id
      FROM trial_balance_settings
      WHERE category LIKE 'bank:%'
      ORDER BY category
    `).all() as any[];

    expect(mappings).toEqual([
      { category: 'bank:1', target_id: '1', account_id: 6 },
      { category: 'bank:2', target_id: '2', account_id: 7 },
    ]);
  });

  it('prevents silent bank-balance edits and deletion of a non-zero account', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    const created = await addBankAction({ name_ar: 'بنك اختباري', current_balance: 250 });
    expect(created.success).toBe(true);
    const bankId = Number(created.id);

    expect((await updateBankAction(bankId, { name_ar: 'بنك محدث', current_balance: 0 })).success).toBe(true);
    expect((mockDb.prepare('SELECT current_balance FROM banks WHERE id = ?').get(bankId) as any).current_balance).toBe(250);
    expect(await deleteBankAction(bankId)).toMatchObject({ success: false, error: expect.stringContaining('رصيد') });
  });

  it('scopes Chart-of-Accounts balances to the signed-in pharmacy', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-1' };
    mockDb.exec(`
      INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id) VALUES
        ('scope-local','2026-09-27','local','admin',10,'ph-1'),
        ('scope-foreign','2026-09-27','foreign','admin',222,'ph-2');
      INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES
        ('scope-local',6,'debit',10),
        ('scope-foreign',6,'debit',222);
    `);

    const result = await getAccountsAction();
    expect(result.success).toBe(true);
    expect((result.data as any[]).find(account => Number(account.id) === 6)?.balance).toBe(10);
  });

  it('persists account-code edits while protecting posted and parent account structure', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);
    mockDb.prepare("INSERT INTO accounts(code,name_ar,type,is_group) VALUES('9.1','Editable','expense',0)").run();
    const editable = mockDb.prepare("SELECT id FROM accounts WHERE code='9.1'").get() as any;

    expect(await updateAccountAction(editable.id, { code: '   ' })).toMatchObject({ success: false });
    mockDb.prepare("INSERT INTO accounts(code,name_ar,type,is_group) VALUES('9.9','Duplicate','expense',0)").run();
    expect(await updateAccountAction(editable.id, { code: '9.9' })).toMatchObject({ success: false, error: expect.stringContaining('مستخدم') });

    expect(await updateAccountAction(editable.id, { code: '9.2', name_ar: 'Editable', type: 'expense', is_group: 0 })).toMatchObject({ success: true });
    expect(mockDb.prepare('SELECT code FROM accounts WHERE id = ?').get(editable.id)).toEqual({ code: '9.2' });

    mockDb.prepare("INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id) VALUES('posted','2026-09-27','posted','admin',1,'local_default')").run();
    mockDb.prepare("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('posted',?,'debit',1)").run(editable.id);
    expect(await updateAccountAction(editable.id, { type: 'asset' })).toMatchObject({ success: false });
    expect(await updateAccountAction(editable.id, { is_group: 1 })).toMatchObject({ success: false });

    mockDb.prepare("INSERT INTO accounts(code,name_ar,type,is_group) VALUES('9.3','Parent','asset',1)").run();
    const parent = mockDb.prepare("SELECT id FROM accounts WHERE code='9.3'").get() as any;
    mockDb.prepare("INSERT INTO accounts(parent_id,code,name_ar,type,is_group) VALUES(?,'9.3.1','Child','asset',0)").run(parent.id);
    expect(await updateAccountAction(parent.id, { is_group: 0 })).toMatchObject({ success: false });

    const mapped = mockDb.prepare("SELECT account_id FROM trial_balance_settings WHERE category='bank_clearing'").get() as any;
    expect(await updateAccountAction(Number(mapped.account_id), { is_group: 1 })).toMatchObject({ success: false });
    expect(await updateAccountAction(Number(mapped.account_id), { type: 'liability' })).toMatchObject({ success: false });

    const revenue = mockDb.prepare("SELECT id FROM accounts WHERE code='3.1'").get() as any;
    expect(await updateAccountAction(Number(revenue.id), { code: '3.1', name_ar: 'إيرادات محدثة', type: 'revenue', is_group: 0 })).toMatchObject({ success: true });
    expect(mockDb.prepare('SELECT name_ar FROM accounts WHERE id = ?').get(revenue.id)).toEqual({ name_ar: 'إيرادات محدثة' });
  });

  it('does not allow core accounting categories to be remapped away from their canonical accounts', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);
    mockDb.prepare("INSERT INTO accounts(code,name_ar,type,is_group) VALUES('9.7','Wrong AP','liability',0)").run();
    const wrong = mockDb.prepare("SELECT id FROM accounts WHERE code='9.7'").get() as any;

    expect(await saveTrialBalanceSettingAction({ category: 'accounts_payable', account_id: Number(wrong.id) }))
      .toMatchObject({ success: false });
    expect(mockDb.prepare(`
      SELECT a.code FROM trial_balance_settings t JOIN accounts a ON a.id=t.account_id
      WHERE t.category='accounts_payable'
    `).get()).toEqual({ code: '2.1' });
  });

  it('protects reserved account codes while allowing custom mapped account renaming', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);
    for (const code of ['1.1.1', '2.1', '1.1.4', '3.2', '3.3', '3.8', '4.4']) {
      const account = mockDb.prepare('SELECT id FROM accounts WHERE code=?').get(code) as any;
      expect(await updateAccountAction(account.id, { code: `${code}x` })).toMatchObject({ success: false, error: expect.stringContaining('حساب أساسي') });
      expect(mockDb.prepare('SELECT code FROM accounts WHERE id=?').get(account.id)).toEqual({ code });
    }
    mockDb.exec("INSERT INTO accounts(code,name_ar,type,is_group) VALUES('9.71','Custom expense','expense',0)");
    const custom = mockDb.prepare("SELECT id FROM accounts WHERE code='9.71'").get() as any;
    expect(await saveTrialBalanceSettingAction({ category: 'expense', target_id: '77', account_id: custom.id })).toMatchObject({ success: true });
    expect(await updateAccountAction(custom.id, { code: '9.72' })).toMatchObject({ success: true });
    expect(mockDb.prepare("SELECT a.code FROM trial_balance_settings t JOIN accounts a ON a.id=t.account_id WHERE t.category='expense:77'").get()).toEqual({ code: '9.72' });
    const { createCashMovementAction } = await import('@/app/actions-client/finance');
    expect(await createCashMovementAction({ type: 'receipt', category: 'other', amount: 25, date: '2026-09-27' })).toMatchObject({ success: true });
  });

  it('posts bank/card opening balances and keeps POS balance changes on transactional flows only', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    const bank = await addBankAction({ name_ar: 'Opening Bank', current_balance: 50 });
    expect(bank.success).toBe(true);
    const card = await addCardAction({ name_ar: 'Opening Card', bank_id: Number(bank.id), current_balance: 15 });
    expect(card.success).toBe(true);

    const opening = mockDb.prepare(`
      SELECT a.code, je.type, SUM(je.amount) amount
      FROM journal_entries je
      JOIN daily_journals dj ON dj.id = je.journal_id
      JOIN accounts a ON a.id = je.account_id
      WHERE dj.description LIKE 'رصيد افتتاحي للبنك:%' OR dj.description LIKE 'رصيد افتتاحي لماكينة الدفع:%'
      GROUP BY a.code, je.type ORDER BY a.code, je.type
    `).all();
    expect(opening).toEqual([
      { code: '1.1.4', type: 'debit', amount: 65 },
      { code: '3.9', type: 'credit', amount: 65 },
    ]);
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM daily_journals WHERE pharmacy_id='local_default' AND (description LIKE 'رصيد افتتاحي للبنك:%' OR description LIKE 'رصيد افتتاحي لماكينة الدفع:%')").get()).toEqual({ count: 2 });

    const pos = await addPointOfSaleAction({ name_ar: 'Operational POS', current_balance: 99 });
    expect(pos.success).toBe(true);
    expect(mockDb.prepare('SELECT current_balance FROM points_of_sale WHERE id = ?').get(pos.id)).toEqual({ current_balance: 0 });
    expect((await updatePointOfSaleAction(Number(pos.id), { name_ar: 'Operational POS', current_balance: 25 })).success).toBe(true);
    expect(mockDb.prepare('SELECT current_balance FROM points_of_sale WHERE id = ?').get(pos.id)).toEqual({ current_balance: 0 });
  });

  it('rejects non-finite opening balances before they can enter bank/card ledgers', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    expect(await addBankAction({ name_ar: 'Infinite Bank', current_balance: Number.POSITIVE_INFINITY })).toMatchObject({ success: false });
    expect(await addCardAction({ name_ar: 'Infinite Card', current_balance: Number.NEGATIVE_INFINITY })).toMatchObject({ success: false });

    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM banks WHERE name_ar='Infinite Bank'").get()).toEqual({ count: 0 });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM credit_cards WHERE name_ar='Infinite Card'").get()).toEqual({ count: 0 });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM daily_journals WHERE description LIKE '%Infinite%'").get()).toEqual({ count: 0 });
  });

  it('rejects invalid card commission percentages instead of persisting corrupt financial rates', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    expect(await addCardAction({ name_ar: 'Infinite Commission', commission_pct: Number.POSITIVE_INFINITY })).toMatchObject({ success: false });
    expect(await addCardAction({ name_ar: 'Negative Commission', commission_pct: -0.01 })).toMatchObject({ success: false });
    expect(await addCardAction({ name_ar: 'Over Commission', commission_pct: 100.01 })).toMatchObject({ success: false });

    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM credit_cards WHERE name_ar IN ('Infinite Commission','Negative Commission','Over Commission')").get()).toEqual({ count: 0 });
  });

  it('skips zero opening journals and reverses debit/credit for negative openings', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    expect(await addBankAction({ name_ar: 'Zero Bank', current_balance: 0 })).toMatchObject({ success: true });
    expect(await addCardAction({ name_ar: 'Overdrawn Card', current_balance: -25 })).toMatchObject({ success: true });

    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM daily_journals WHERE description='رصيد افتتاحي للبنك: Zero Bank'").get()).toEqual({ count: 0 });
    expect(mockDb.prepare(`
      SELECT a.code, je.type, je.amount
      FROM journal_entries je
      JOIN daily_journals dj ON dj.id = je.journal_id
      JOIN accounts a ON a.id = je.account_id
      WHERE dj.description = 'رصيد افتتاحي لماكينة الدفع: Overdrawn Card'
      ORDER BY je.type
    `).all()).toEqual([
      { code: '1.1.4', type: 'credit', amount: 25 },
      { code: '3.9', type: 'debit', amount: 25 },
    ]);
  });

  it('persists a cross-feature financial lifecycle across a database restart with balanced, pharmacy-scoped journals', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pharma-financial-restart-'));
    const dbPath = join(tempDir, 'financial-lifecycle.sqlite');

    try {
      mockDb = new Database(dbPath);
      applyAllMigrations(mockDb);
      seedBaselineEntities(mockDb);
      mockDb.exec(`
        UPDATE users SET pharmacy_id = 'ph-restart' WHERE id = 'admin';
        UPDATE banks SET pharmacy_id = 'ph-restart' WHERE id = 1;
        INSERT INTO users (id, username, password_hash, role, full_name, pharmacy_id, is_active)
        VALUES ('foreign-owner', 'foreign-owner', 'hash', 'owner', 'Foreign Owner', 'ph-foreign', 1);
      `);
      mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-restart' };

      const opened = await openShiftAction({ starting_cash_amount: 200 });
      expect(opened).toMatchObject({ success: true });
      const shiftId = String(opened.shiftId);

      expect(await createPurchaseInvoiceAction({
        supplier_id: 1,
        invoice_number: 'PERSIST-PURCHASE-1',
        invoice_date: '2026-09-28',
        payment_method: 'credit',
        status: 'completed',
        cart: [{
          id: 5001,
          quantity: 10,
          cost_price: 30,
          selling_price: 40,
          expiry_date: '2029-12-31',
          strips_per_box: 2,
          barcode: '62210001',
        }],
      })).toMatchObject({ success: true });

      const inventory = mockDb.prepare('SELECT id FROM inventory WHERE drug_id = 5001').get() as any;
      const sale = await processCheckoutAction({
        patient_id: 'patient-1',
        shift_id: shiftId,
        payment_method: 'credit',
        status: 'completed',
        total_discount: 0,
        items: [{
          drug_id: 5001,
          inventory_id: inventory.id,
          quantity_sold: 2,
          unit_price: 40,
          selected_unit: 'large',
        }],
      });
      expect(sale).toMatchObject({ success: true });

      expect(await addPatientPaymentAction({
        patient_id: 'patient-1',
        shift_id: shiftId,
        amount: 30,
        payment_method: 'cash',
        notes: 'restart lifecycle patient payment',
        date: '2026-09-28',
      })).toMatchObject({ success: true, remainingBalance: 50 });

      expect(await addSupplierPaymentAction({
        supplier_id: 1,
        amount: 50,
        payment_method: 'cash',
        notes: 'restart lifecycle supplier payment',
        date: '2026-09-28',
      })).toMatchObject({ success: true, remainingBalance: 250 });

      expect(await addFinancialNoticeAction({
        target_type: 'supplier',
        target_id: '1',
        type: 'debit',
        amount: 20,
        reason: 'supplier balance correction',
        date: '2026-09-28',
      })).toMatchObject({ success: true });

      expect(await addFinancialNoticeAction({
        target_type: 'customer',
        target_id: 'patient-1',
        type: 'credit',
        amount: 10,
        reason: 'customer balance correction',
        date: '2026-09-28',
      })).toMatchObject({ success: true });

      expect(await createCashMovementAction({
        type: 'receipt',
        category: 'other',
        amount: 15,
        notes: 'restart lifecycle other income',
        date: '2026-09-28',
        shift_id: shiftId,
      })).toMatchObject({ success: true });

      expect(mockDb.prepare('SELECT balance FROM suppliers WHERE id = 1').get()).toEqual({ balance: 270 });
      expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get(inventory.id)).toEqual({ quantity: 8 });

      const patientOutstanding = mockDb.prepare(`
        SELECT
          COALESCE((SELECT SUM(total_amount) FROM sales_invoices WHERE patient_id='patient-1' AND payment_method='credit' AND status='completed'), 0)
          - COALESCE((SELECT SUM(amount) FROM patient_transactions WHERE patient_id='patient-1' AND type='payment'), 0)
          + COALESCE((SELECT SUM(amount) FROM patient_transactions WHERE patient_id='patient-1' AND type='adjustment'), 0)
          AS balance
      `).get() as any;
      expect(Number(patientOutstanding.balance)).toBe(40);

      const unbalancedBeforeRestart = mockDb.prepare(`
        SELECT dj.id
        FROM daily_journals dj
        JOIN journal_entries je ON je.journal_id = dj.id
        GROUP BY dj.id
        HAVING ABS(
          SUM(CASE WHEN je.type='debit' THEN je.amount ELSE 0 END)
          - SUM(CASE WHEN je.type='credit' THEN je.amount ELSE 0 END)
        ) > 0.000001
      `).all();
      expect(unbalancedBeforeRestart).toEqual([]);

      const expectedDrawerCash = 200 + 30 - 50 + 15;
      const handover = await processHandoverAction({
        shiftId,
        actualCash: expectedDrawerCash,
        transferAmount: 100,
        transferTargetId: '1',
        transferTargetType: 'bank',
        receiverUsername: 'admin',
        receiverPasswordHash: 'hash',
      });
      expect(handover).toMatchObject({
        success: true,
        difference: 0,
        remainingCash: expectedDrawerCash - 100,
      });
      expect(mockDb.prepare('SELECT current_balance FROM banks WHERE id=1').get()).toEqual({ current_balance: 5100 });

      const persistedBeforeRestart = {
        supplier: mockDb.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
        patientPayments: mockDb.prepare("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM patient_transactions WHERE patient_id='patient-1' AND type='payment'").get(),
        patientAdjustments: mockDb.prepare("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM patient_transactions WHERE patient_id='patient-1' AND type='adjustment'").get(),
        inventory: mockDb.prepare('SELECT quantity FROM inventory WHERE id=?').get(inventory.id),
        bank: mockDb.prepare('SELECT current_balance FROM banks WHERE id=1').get(),
        journals: mockDb.prepare("SELECT COUNT(*) AS count FROM daily_journals WHERE pharmacy_id='ph-restart'").get(),
        entries: mockDb.prepare('SELECT COUNT(*) AS count FROM journal_entries').get(),
        notices: mockDb.prepare("SELECT COUNT(*) AS count FROM financial_notices WHERE pharmacy_id='ph-restart'").get(),
        movements: mockDb.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE pharmacy_id='ph-restart'").get(),
        openShift: mockDb.prepare("SELECT id, starting_cash FROM shifts WHERE pharmacy_id='ph-restart' AND status='open'").get(),
      };

      mockDb.close();
      mockDb = new Database(dbPath);

      expect({
        supplier: mockDb.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
        patientPayments: mockDb.prepare("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM patient_transactions WHERE patient_id='patient-1' AND type='payment'").get(),
        patientAdjustments: mockDb.prepare("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM patient_transactions WHERE patient_id='patient-1' AND type='adjustment'").get(),
        inventory: mockDb.prepare('SELECT quantity FROM inventory WHERE id=?').get(inventory.id),
        bank: mockDb.prepare('SELECT current_balance FROM banks WHERE id=1').get(),
        journals: mockDb.prepare("SELECT COUNT(*) AS count FROM daily_journals WHERE pharmacy_id='ph-restart'").get(),
        entries: mockDb.prepare('SELECT COUNT(*) AS count FROM journal_entries').get(),
        notices: mockDb.prepare("SELECT COUNT(*) AS count FROM financial_notices WHERE pharmacy_id='ph-restart'").get(),
        movements: mockDb.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE pharmacy_id='ph-restart'").get(),
        openShift: mockDb.prepare("SELECT id, starting_cash FROM shifts WHERE pharmacy_id='ph-restart' AND status='open'").get(),
      }).toEqual(persistedBeforeRestart);

      const trialBalance = await getTrialBalanceAction();
      expect(trialBalance.success).toBe(true);
      const totalDebits = (trialBalance.data || []).reduce((sum: number, row: any) => sum + Number(row.total_debit || 0), 0);
      const totalCredits = (trialBalance.data || []).reduce((sum: number, row: any) => sum + Number(row.total_credit || 0), 0);
      expect(totalDebits).toBeCloseTo(totalCredits, 8);

      expect((await getJournalsAction()).data?.length).toBe((persistedBeforeRestart.journals as any).count);
      mockSession = { id: 'foreign-owner', role: 'owner', pharmacy_id: 'ph-foreign' };
      expect((await getJournalsAction()).data).toEqual([]);

      // Branch-owned finance definitions are pharmacy-scoped as of migration 028.
      expect((await getBanksAction()).data?.find((bank: any) => Number(bank.id) === 1)).toBeUndefined();
      // Supplier and patient master/subledger ownership remains intentionally global
      // in the current architecture; only their branch-owned operational rows are scoped.
      expect((await getSuppliersAction()).data?.find((supplier: any) => Number(supplier.id) === 1)?.balance).toBe(270);
      const foreignPatientProfile = await getPatientProfileAction('patient-1');
      expect(foreignPatientProfile).toMatchObject({
        success: true,
        data: {
          purchaseHistory: [],
          outstandingBalance: 40,
        },
      });
      expect((foreignPatientProfile.data as any)?.payments).toHaveLength(1);
    } finally {
      try { mockDb?.close(); } catch {}
      rmSync(tempDir, { recursive: true, force: true });
      mockDb = new Database(':memory:');
      mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    }
  });
});
