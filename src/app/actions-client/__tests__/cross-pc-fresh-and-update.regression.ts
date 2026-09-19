import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

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
    dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
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

import { normalizeDatabaseTimestamps } from '@/lib/db/tauri';
import {
  createPurchaseInvoiceAction,
  completePurchaseInvoiceAction,
  updateCompletedPurchaseInvoiceAction,
  createPurchaseReturnAction,
} from '@/app/actions-client/purchases';
import {
  addToShortagesAction,
  getShortagesAction,
} from '@/app/actions-client/shortages';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { openShiftAction, getCurrentShiftAction } from '@/app/actions-client/shifts';
import { processHandoverAction } from '@/app/actions-client/handover';
import { createReturnAction } from '@/app/actions-client/returns';
import {
  addBankAction,
  updateBankAction,
  deleteBankAction,
  getBanksAction,
  addCardAction,
  getCardsAction,
  addPointOfSaleAction,
  getPointsOfSaleAction,
  addPaperAction,
  getPapersAction,
  updatePaperStatusAction,
  createManualJournalAction,
  getJournalsAction,
  saveTrialBalanceSettingAction,
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
  const addCol = (table: string, col: string, typeDef: string) => {
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
  addCol('sales_invoices', 'user_id', 'TEXT');
  addCol('sales_invoices', 'pharmacy_id', 'TEXT');
  addCol('returns', 'pharmacy_id', 'TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_drug_status ON shortages(pharmacy_id, drug_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_status ON shortages(pharmacy_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_drug_id ON shortages(drug_id)');
  db.exec("UPDATE shortages SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''");
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
      '021_returns_pharmacy_scope.sql',
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
    expect(completedShortage.status).toBe('received');

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
});
